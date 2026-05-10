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

  extra_19: {
    mode: "payment",
    amount: 19,
    plan: "extra_19",
    grantedCaseCount: 1,
    name: "Axe Flow - Dossier supplémentaire",
    unitAmount: 1900,
  },
};

function normalizeOfferType(value) {
  const v = String(value || "").trim();

  if (["monthly_89", "subscription_89", "pro_89", "abonnement_89", "89"].includes(v)) {
    return "monthly_89";
  }

  if (["extra_19", "supplement_19", "dossier_sup_19", "19"].includes(v)) {
    return "extra_19";
  }

  if (["one_shot_49", "dossier_49", "49"].includes(v)) {
    return "one_shot_49";
  }

  return "";
}

function inferOfferFromSession(session) {
  const metadataOffer = normalizeOfferType(session.metadata?.offerType);
  if (metadataOffer) return metadataOffer;

  const amountTotal = Number(session.amount_total || 0);
  const mode = String(session.mode || "");

  if (mode === "subscription" || amountTotal === 8900) return "monthly_89";
  if (amountTotal === 1900) return "extra_19";
  if (amountTotal === 4900) return "one_shot_49";

  return "";
}

function getUidFromSession(session) {
  return (
    String(session.metadata?.uid || "").trim() ||
    String(session.client_reference_id || "").trim()
  );
}

function getEmailFromSession(session) {
  return (
    String(session.metadata?.email || "").trim() ||
    String(session.customer_details?.email || "").trim() ||
    String(session.customer_email || "").trim()
  );
}

async function alreadyProcessed(userRef, stripeSessionId) {
  if (!stripeSessionId) return false;

  const existingPaymentSnap = await userRef
    .collection("payments")
    .where("stripeSessionId", "==", stripeSessionId)
    .limit(1)
    .get();

  return !existingPaymentSnap.empty;
}

async function createEntitlementFromCheckoutSession(session) {
  const uid = getUidFromSession(session);
  const email = getEmailFromSession(session);
  const offerType = inferOfferFromSession(session);

  if (!uid || !offerType) {
    console.error("Webhook impossible à rattacher :", {
      uid,
      offerType,
      client_reference_id: session.client_reference_id || "",
      metadata: session.metadata || {},
      amount_total: session.amount_total || "",
      mode: session.mode || "",
      sessionId: session.id,
    });
    throw new Error("UID ou offre manquant");
  }

  const offer = OFFERS[offerType];

  if (!offer) {
    console.error("Offre inconnue webhook:", offerType);
    throw new Error("Offre inconnue");
  }

  const userRef = db.collection("users").doc(uid);
  const now = admin.firestore.Timestamp.now();

  if (await alreadyProcessed(userRef, session.id)) {
    console.log("Paiement déjà traité:", session.id);
    return { status: "already_processed", uid, offerType };
  }

  const paymentRef = userRef.collection("payments").doc(`stripe_${session.id}`);
  const entitlementRef = userRef.collection("entitlements").doc(`stripe_${session.id}`);

  await db.runTransaction(async (tx) => {
    const paymentDoc = await tx.get(paymentRef);

    if (paymentDoc.exists) {
      return;
    }

    tx.set(paymentRef, {
      type: offerType,
      status: "paid",
      provider: "stripe",
      amount: offer.amount,
      currency: "eur",
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || "",
      stripeSubscriptionId: session.subscription || "",
      stripeCustomerId: session.customer || "",
      paymentLinkId: session.payment_link || "",
      createdAt: now,
      updatedAt: now,
    });

    tx.set(entitlementRef, {
      type: offerType,
      status: "active",
      grantedCaseCount: offer.grantedCaseCount,
      usedCaseCount: 0,
      validFrom: now,
      validUntil: null,
      source: "stripe_webhook",
      sourcePaymentId: session.id,
      stripeSessionId: session.id,
      stripeSubscriptionId: session.subscription || "",
      stripeCustomerId: session.customer || "",
      createdAt: now,
      updatedAt: now,
    });

    const userUpdate = {
      uid,
      email: email || "",
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

    if (offerType === "one_shot_49" || offerType === "extra_19") {
      userUpdate.subscriptionStatus = "none";
    }

    tx.set(userRef, userUpdate, { merge: true });
  });

  console.log("Paiement traité avec succès:", {
    uid,
    email,
    offerType,
    sessionId: session.id,
  });

  return { status: "created", uid, offerType };
}

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
      const normalizedOfferType = normalizeOfferType(offerType);

      console.log("createCheckoutSession payload:", {
        uid,
        email,
        offerType: normalizedOfferType,
      });

      if (!uid || !email || !normalizedOfferType) {
        return res.status(400).json({
          error: "uid, email ou offerType manquant",
        });
      }

      const offer = OFFERS[normalizedOfferType];

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

      const sessionPayload = {
        mode: offer.mode,
        customer_email: email,
        client_reference_id: uid,
        line_items: [lineItem],
        success_url: `${APP_URL}/merci.html?offer=${normalizedOfferType}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/index.html?payment=cancelled`,
        metadata: {
          uid,
          email,
          offerType: normalizedOfferType,
        },
      };

      if (offer.mode === "subscription") {
        sessionPayload.subscription_data = {
          metadata: {
            uid,
            email,
            offerType: normalizedOfferType,
          },
        };
      }

      const session = await stripe.checkout.sessions.create(sessionPayload);

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

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        await createEntitlementFromCheckoutSession(session);
        return res.status(200).send("ok");
      }

      if (event.type === "invoice.paid") {
        // Prévu pour la V2 abonnement.
        // À activer quand les abonnements live auront des métadonnées uid/offerType garanties.
        console.log("invoice.paid reçu mais non traité pour le moment");
        return res.status(200).send("invoice.paid ignoré");
      }

      if (event.type === "customer.subscription.deleted") {
        // Prévu pour la V2 abonnement.
        // À activer quand on stockera stripeSubscriptionId -> uid de façon systématique.
        console.log("customer.subscription.deleted reçu mais non traité pour le moment");
        return res.status(200).send("subscription.deleted ignoré");
      }

      return res.status(200).send("Event ignoré");
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
'''
path = Path('/mnt/data/functions-index-stripe-webhook-live.js')
path.write_text(code, encoding='utf-8')
print(path)
