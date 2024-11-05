const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
    });
}

async function handleSuccessfulPayment(session) {
    const { client_reference_id: userId, metadata } = session;
    if (!userId) {
        throw new Error('No user ID provided in session');
    }

    const points = metadata?.points ? parseInt(metadata.points) : 0;
    if (!points) {
        throw new Error('No points value provided in session metadata');
    }

    const userRef = admin.firestore().collection('users').doc(userId);
    await admin.firestore().runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
            throw new Error('User document not found');
        }
        const currentPoints = userDoc.data().points || 0;
        transaction.update(userRef, {
            points: currentPoints + points,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
    });
}

module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error(`Webhook Error: ${err.message}`);
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    try {
        if (event.type === 'checkout.session.completed') {
            await handleSuccessfulPayment(event.data.object);
        }
        
        return res.json({ received: true });
    } catch (error) {
        console.error('Webhook processing error:', error);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
}; 