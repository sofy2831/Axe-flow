const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
setGlobalOptions({ region: "europe-west9" });

const db = admin.firestore();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-03-31.basil",
});

const APP_URL = "https://flow.axe-dossier.fr";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const OFFERS = {
  one_shot_49: {
    mode: "payment",
    amount: 49,
    line_items: [
      {
        price_data: {
          currency: "eur",
          product_data: {
            name: "Axe Flow - Dossier ponctuel",
          },
          unit_amount: 4900,
        },
        quantity: 1,
      },
    ],
  },
  monthly_89: {
    mode: "subscription",
    amount: 89,
    line_items: [
      {
        price_data: {
          currency: "eur",
          recurring: { interval: "month" },
          product_data: {
            name: "Axe Flow - Offre Pro",
          },
          unit_amount: 8900,
        },
        quantity: 1,
      },
    ],
  },
};

exports.createCheckoutSession = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée" });
    }

    const { uid, email, offerType } = req.body || {};
    const offer = OFFERS[offerType];

    if (!uid || !email || !offerType) {
      return res.status(400).json({ error: "uid, email ou offerType manquant" });
    }

    if (!offer) {
      return res.status(400).json({ error: "Offre inconnue" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: offer.mode,
      customer_email: email,
      line_items: offer.line_items,
      success_url: `${APP_URL}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/index.html?payment=cancelled`,
      metadata: {
        uid,
        email,
        offerType,
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("createCheckoutSession:", error);
    return res.status(500).json({ error: "Erreur session Stripe" });
  }
});

exports.stripeWebhook = onRequest({ cors: false }, async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];

    const event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const uid = session.metadata?.uid;
      const email = session.metadata?.email || "";
      const offerType = session.metadata?.offerType;

      if (!uid || !offerType) {
        return res.status(400).send("Metadata manquante");
      }

      const userRef = db.collection("users").doc(uid);
      const now = admin.firestore.Timestamp.now();

      const existingPayment = await userRef
        .collection("payments")
        .where("stripeSessionId", "==", session.id)
        .limit(1)
        .get();

      if (!existingPayment.empty) {
        return res.status(200).send("Déjà traité");
      }

      await userRef.collection("payments").add({
        type: offerType,
        provider: "stripe",
        status: "paid",
        amount: offerType === "one_shot_49" ? 49 : 89,
        currency: "eur",
        stripeSessionId: session.id,
        stripePaymentIntentId: session.payment_intent || "",
        createdAt: now,
        updatedAt: now,
      });

      await userRef.collection("entitlements").add({
        type: offerType,
        status: "active",
        grantedCaseCount: offerType === "one_shot_49" ? 1 : 3,
        usedCaseCount: 0,
        source: "stripe",
        sourcePaymentId: session.id,
        createdAt: now,
        updatedAt: now,
      });

      const userUpdate = {
        email,
        plan: offerType,
        subscriptionStatus: "active",
        updatedAt: now,
      };

      if (offerType === "monthly_89") {
        userUpdate.monthlyQuota = 3;
      }

      await userRef.set(userUpdate, { merge: true });
    }

    return res.status(200).send("ok");
  } catch (error) {
    console.error("stripeWebhook:", error);
    return res.status(400).send("Webhook error");
  }
});