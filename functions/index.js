const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

admin.initializeApp();

setGlobalOptions({
  region: "europe-west9",
});

const db = admin.firestore();

const APP_URL = "https://flow.axe-dossier.fr";

const OFFERS = {
  one_shot_49: {
    mode: "payment",
    amount: 49,
    plan: "one_shot_49",
    grantedCaseCount: 1,
    name: "Axe Flow - Dossier ponctuel",
    unitAmount: 4900,
  },

  monthly_89: {
    mode: "subscription",
    amount: 89,
    plan: "monthly_89",
    grantedCaseCount: 3,
    name: "Axe Flow - Offre Pro",
    unitAmount: 8900,
  },
};

exports.createCheckoutSession = onRequest(
  {
    cors: true,
    secrets: [STRIPE_SECRET_KEY],
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({
          error: "Méthode non autorisée",
        });
      }

      const stripeSecret = STRIPE_SECRET_KEY.value();

      if (!stripeSecret) {
        console.error("STRIPE_SECRET_KEY manquant");
        return res.status(500).json({
          error: "Configuration Stripe manquante",
        });
      }

      const stripe = Stripe(stripeSecret);

      const { uid, email, offerType } = req.body || {};

      console.log("createCheckoutSession payload:", {
        uid,
        email,
        offerType,
      });

      if (!uid || !email || !offerType) {
        return res.status(400).json({
          error: "uid, email ou offerType manquant",
        });
      }

      const offer = OFFERS[offerType];

      if (!offer) {
        return res.status(400).json({
          error: "Offre inconnue",
        });
      }

      const lineItem = {
        price_data: {
          currency: "eur",
          product_data: {
            name: offer.name,
          },
          unit_amount: offer.unitAmount,
        },
        quantity: 1,
      };

      if (offer.mode === "subscription") {
        lineItem.price_data.recurring = {
          interval: "month",
        };
      }

      const session = await stripe.checkout.sessions.create({
        mode: offer.mode,
        customer_email: email,
        line_items: [lineItem],
        success_url: `${APP_URL}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/index.html?payment=cancelled`,
        metadata: {
          uid,
          email,
          offerType,
        },
      });

      console.log("Stripe session créée:", session.id);

      return res.status(200).json({
        url: session.url,
      });
    } catch (error) {
      console.error("createCheckoutSession ERROR:", {
        message: error.message,
        type: error.type,
        code: error.code,
        stack: error.stack,
      });

      return res.status(500).json({
        error: error.message || "Erreur session Stripe",
      });
    }
  }
);

exports.stripeWebhook = onRequest(
  {
    cors: false,
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
  },
  async (req, res) => {
    try {
      const stripeSecret = STRIPE_SECRET_KEY.value();
      const webhookSecret = STRIPE_WEBHOOK_SECRET.value();

      if (!stripeSecret || !webhookSecret) {
        console.error("Secret Stripe ou Webhook manquant");
        return res.status(500).send("Configuration Stripe manquante");
      }

      const stripe = Stripe(stripeSecret);

      const sig = req.headers["stripe-signature"];

      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.rawBody,
          sig,
          webhookSecret
        );
      } catch (error) {
        console.error("Webhook signature invalide:", error.message);
        return res.status(400).send(`Webhook Error: ${error.message}`);
      }

      console.log("Webhook reçu:", event.type);

      if (event.type !== "checkout.session.completed") {
        return res.status(200).send("Event ignoré");
      }

      const session = event.data.object;

      const uid = session.metadata?.uid || "";
      const email = session.metadata?.email || "";
      const offerType = session.metadata?.offerType || "";

      if (!uid || !offerType) {
        console.error("Metadata manquante:", session.metadata);
        return res.status(400).send("Metadata manquante");
      }

      const offer = OFFERS[offerType];

      if (!offer) {
        console.error("Offre inconnue webhook:", offerType);
        return res.status(400).send("Offre inconnue");
      }

      const userRef = db.collection("users").doc(uid);
      const now = admin.firestore.Timestamp.now();

      const existingPaymentSnap = await userRef
        .collection("payments")
        .where("stripeSessionId", "==", session.id)
        .limit(1)
        .get();

      if (!existingPaymentSnap.empty) {
        console.log("Paiement déjà traité:", session.id);
        return res.status(200).send("Déjà traité");
      }

      await userRef.collection("payments").add({
        type: offerType,
        status: "paid",
        provider: "stripe",
        amount: offer.amount,
        currency: "eur",
        stripeSessionId: session.id,
        stripePaymentIntentId: session.payment_intent || "",
        stripeSubscriptionId: session.subscription || "",
        createdAt: now,
        updatedAt: now,
      });

      await userRef.collection("entitlements").add({
        type: offerType,
        status: "active",
        grantedCaseCount: offer.grantedCaseCount,
        usedCaseCount: 0,
        source: "stripe",
        sourcePaymentId: session.id,
        createdAt: now,
        updatedAt: now,
      });

      const userUpdate = {
        uid,
        email,
        role: "client",
        plan: offer.plan,
        planType: offer.plan,
        entitlement: offerType,
        entitlementStatus: "active",
        paymentStatus: "paid",
        accountStatus: "active",
        updatedAt: now,
      };

      if (offerType === "monthly_89") {
        userUpdate.subscriptionStatus = "active";
        userUpdate.monthlyQuota = 3;
        userUpdate.monthlyUsed = 0;
      }

      if (offerType === "one_shot_49") {
        userUpdate.subscriptionStatus = "none";
      }

      await userRef.set(userUpdate, { merge: true });

      console.log("Paiement traité avec succès:", {
        uid,
        email,
        offerType,
        sessionId: session.id,
      });

      return res.status(200).send("ok");
    } catch (error) {
      console.error("stripeWebhook ERROR:", {
        message: error.message,
        type: error.type,
        code: error.code,
        stack: error.stack,
      });

      return res.status(500).send("Webhook error");
    }
  }
);
