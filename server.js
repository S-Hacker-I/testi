require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin first
let adminInitialized = false;
try {
    if (!adminInitialized) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
            })
        });
        adminInitialized = true;
    }
} catch (error) {
    console.error('Firebase Admin initialization error:', error);
}

const app = express();

// CORS configuration
app.use(cors({
    origin: ['https://testi-gilt.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
}));

// Config endpoint (BEFORE other routes)
app.get('/api/config', async (req, res) => {
    try {
        // Verify environment variables
        if (!process.env.STRIPE_PUBLISHABLE_KEY) {
            throw new Error('Stripe publishable key is not configured');
        }

        // Log the request
        console.log('Config endpoint called:', {
            origin: req.headers.origin,
            referer: req.headers.referer
        });

        // Send response
        return res.status(200).json({
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
            environment: process.env.NODE_ENV
        });
    } catch (error) {
        console.error('Config endpoint error:', error);
        return res.status(500).json({
            error: {
                message: error.message || 'Internal server error',
                code: 'CONFIG_ERROR'
            }
        });
    }
});

// Webhook endpoint (raw body parsing)
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
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
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            console.log('Payment successful:', session.id);
            
            // Handle the payment
            try {
                await handleSuccessfulPayment(session);
                console.log('Points added successfully');
            } catch (error) {
                console.error('Error handling payment:', error);
                return res.status(500).send('Error handling payment');
            }
            break;
            
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({received: true});
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', {
        message: err.message,
        stack: err.stack,
        path: req.path
    });
    
    res.status(500).json({
        error: {
            message: 'An internal server error occurred',
            code: 'SERVER_ERROR'
        }
    });
});

// Export the Express API
module.exports = app;

async function handleSuccessfulPayment(session) {
    const { userId, points } = session.metadata;
    
    if (!userId || !points) {
        throw new Error('Missing metadata in session');
    }

    const db = admin.firestore();
    const pointsToAdd = parseInt(points);

    try {
        await db.runTransaction(async (transaction) => {
            // Get user document
            const userRef = db.collection('users').doc(userId);
            const userDoc = await transaction.get(userRef);
            const currentPoints = userDoc.exists ? (userDoc.data().points || 0) : 0;

            // Create purchase record first
            const purchaseRef = db.collection('purchases').doc();
            transaction.set(purchaseRef, {
                userId,
                points: pointsToAdd,
                amount: session.amount_total,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                sessionId: session.id,
                status: 'completed',
                paymentIntent: session.payment_intent
            });

            // Update user points
            transaction.set(userRef, {
                points: currentPoints + pointsToAdd,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });

        console.log('Payment processed successfully:', {
            userId,
            pointsAdded: pointsToAdd,
            sessionId: session.id
        });
    } catch (error) {
        console.error('Payment processing failed:', error);
        throw error;
    }
}
