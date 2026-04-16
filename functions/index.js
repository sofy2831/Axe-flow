const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

admin.initializeApp();
setGlobalOptions({ region: "europe-west9" });

const db = admin.firestore();
const APP_URL = "https://flow.axe-dossier.fr";

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

  extra_case_19: {
    mode: "payment",
    amount: 19,
    line_items: [
      {
        price_data: {
          currency: "eur",
          product_data: {
            name: "Axe Flow - Dossier supplémentaire",
          },
          unit_amount: 1900,
        },
        quantity: 1,
      },
    ],
  },
};

exports.createCheckoutSession = onRequest(
  {
    cors: true,
    secrets: [STRIPE_SECRET_KEY],
  },
  async (req, res) => {
    const stripe = Stripe(STRIPE_SECRET_KEY.value(), {
      apiVersion: "2025-03-31.basil",
    });

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
  }
);

exports.stripeWebhook = onRequest(
  {
    cors: false,
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
  },
  async (req, res) => {
    const stripe = Stripe(STRIPE_SECRET_KEY.value(), {
      apiVersion: "2025-03-31.basil",
    });

    try {
      const sig = req.headers["stripe-signature"];

      const event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET.value()
      );

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const uid = session.metadata?.uid;
        const email = session.metadata?.email || "";
        const offerType = session.metadata?.offerType;

        if (!uid || !offerType) {
          return res.status(400).send("Metadata manquante");
        }

        const offer = OFFERS[offerType];
        if (!offer) {
          return res.status(400).send("Offre inconnue");
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
          amount: offer.amount,
          currency: "eur",
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent || "",
          createdAt: now,
          updatedAt: now,
        });

        await userRef.collection("entitlements").add({
          type: offerType,
          status: "active",
          grantedCaseCount: offerType === "monthly_89" ? 3 : 1,
          usedCaseCount: 0,
          source: "stripe",
          sourcePaymentId: session.id,
          createdAt: now,
          updatedAt: now,
        });

        const userSnap = await userRef.get();
        const currentPlan = userSnap.exists ? userSnap.data().plan || "unknown" : "unknown";

        const userUpdate = {
          email,
          plan: offerType === "extra_case_19" ? currentPlan : offerType,
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
  }
);
