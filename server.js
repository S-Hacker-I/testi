require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

const app = express();

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.raw({ type: 'application/json' }));
app.use(express.static('public'));

// Initialize Firebase Admin
try {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
    });
} catch (error) {
    console.error('Firebase initialization error:', error);
}

// Debug endpoint to check environment variables
app.get('/api/debug', (req, res) => {
    res.json({
        hasStripeKey: !!process.env.STRIPE_PUBLISHABLE_KEY,
        hasSecretKey: !!process.env.STRIPE_SECRET_KEY,
        hasFirebaseProjectId: !!process.env.FIREBASE_PROJECT_ID,
        environment: process.env.NODE_ENV
    });
});

// Config endpoint with better error handling
app.get('/api/config', (req, res) => {
    console.log('Config endpoint called');
    try {
        if (!process.env.STRIPE_PUBLISHABLE_KEY) {
            console.error('Stripe publishable key missing');
            return res.status(500).json({
                error: 'Stripe configuration missing'
            });
        }

        res.json({
            stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
        });
    } catch (error) {
        console.error('Config endpoint error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

// Add this before your routes
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`, {
        body: req.body,
        query: req.query
    });
    next();
});

// Create points checkout session
app.post('/api/create-points-checkout', async (req, res) => {
    console.log('Checkout endpoint called');
    
    try {
        const { points, userId, email } = req.body;
        
        console.log('Request body:', { points, userId, email });

        if (!points || !userId || points < 10 || points > 5000) {
            return res.status(400).json({ 
                error: 'Invalid points amount or missing user ID' 
            });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${points} Points`,
                        description: `Purchase ${points} points for your account`
                    },
                    unit_amount: points * 10 // $0.10 per point
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.BASE_URL}/dashboard?canceled=true`,
            customer_email: email,
            metadata: {
                userId,
                points: points.toString()
            }
        });

        console.log('Session created:', session.id);
        res.json({ url: session.url });
        
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ 
            error: error.message || 'Failed to create checkout session' 
        });
    }
});

// Add success endpoint to verify payment
app.get('/api/checkout-session/:sessionId', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
        res.json(session);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Catch-all route for static files
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', req.path));
});

// Add this after your routes
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// Stripe webhook handler - Move this BEFORE the express.json() middleware
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    console.log('Webhook received');

    try {
        const event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );

        console.log('Webhook event type:', event.type);

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            console.log('Processing successful payment:', session.id);

            // Handle the successful payment
            await handleSuccessfulPayment(session);
            console.log('Payment processed successfully');
        }

        res.json({received: true});
    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

// Function to handle successful payments - Update with better error handling
async function handleSuccessfulPayment(session) {
    const { userId, points } = session.metadata;
    const db = admin.firestore();
    
    console.log('Processing payment for:', { userId, points, sessionId: session.id });

    try {
        // Use a transaction to ensure data consistency
        await db.runTransaction(async (transaction) => {
            const userRef = db.collection('users').doc(userId);
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
                console.log('Creating new user document');
                transaction.set(userRef, {
                    points: parseInt(points),
                    created: admin.firestore.FieldValue.serverTimestamp(),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                console.log('Updating existing user document');
                const currentPoints = userDoc.data().points || 0;
                const pointsToAdd = parseInt(points);
                const newTotal = currentPoints + pointsToAdd;

                transaction.update(userRef, {
                    points: newTotal,
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            // Create purchase record
            const purchaseRef = db.collection('purchases').doc();
            transaction.set(purchaseRef, {
                userId: userId,
                points: parseInt(points),
                amount: session.amount_total,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                sessionId: session.id,
                status: 'completed',
                paymentIntent: session.payment_intent
            });
        });

        console.log('Transaction completed successfully');
    } catch (error) {
        console.error('Error in handleSuccessfulPayment:', error);
        throw error;
    }
}

// Export for Vercel
module.exports = app;
