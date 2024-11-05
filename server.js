require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

const app = express();

// Add this at the top of server.js
console.log('Environment check:', {
    hasStripePublishableKey: !!process.env.STRIPE_PUBLISHABLE_KEY,
    hasStripeSecretKey: !!process.env.STRIPE_SECRET_KEY,
    hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
    nodeEnv: process.env.NODE_ENV
});

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

// Debug middleware
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`, {
        headers: req.headers,
        query: req.query
    });
    next();
});

// Config endpoint with better error handling
app.get('/api/config', async (req, res) => {
    console.log('Config endpoint called');
    
    // Set proper headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    
    
    try {
        // Check for required environment variables
        if (!process.env.STRIPE_PUBLISHABLE_KEY) {
            console.error('Stripe publishable key missing');
            return res.status(500).json({
                success: false,
                error: 'Stripe configuration missing'
            });
        }

        // Return the configuration
        return res.status(200).json({
            success: true,
            stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
        });
    } catch (error) {
        console.error('Config endpoint error:', error);
        return res.status(500).json({
            success: false,
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

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Move this BEFORE all other middleware
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    console.log('Webhook received', { signature: !!sig });

    try {
        const event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );

        console.log('Webhook event:', { 
            type: event.type,
            id: event.id
        });

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            console.log('Processing payment:', {
                sessionId: session.id,
                metadata: session.metadata,
                amount: session.amount_total
            });

            // Handle the successful payment
            await handleSuccessfulPayment(session);
        }

        res.json({received: true});
    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

// Update the payment handler
async function handleSuccessfulPayment(session) {
    const { userId, points } = session.metadata;
    if (!userId || !points) {
        console.error('Missing metadata:', session.metadata);
        return;
    }

    const db = admin.firestore();
    console.log('Processing payment for:', { userId, points, sessionId: session.id });

    try {
        await db.runTransaction(async (transaction) => {
            const userRef = db.collection('users').doc(userId);
            const userDoc = await transaction.get(userRef);

            // Calculate new points total
            const currentPoints = userDoc.exists ? (userDoc.data().points || 0) : 0;
            const pointsToAdd = parseInt(points);
            const newTotal = currentPoints + pointsToAdd;

            // Update or create user document
            if (!userDoc.exists) {
                transaction.set(userRef, {
                    points: newTotal,
                    created: admin.firestore.FieldValue.serverTimestamp(),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                transaction.update(userRef, {
                    points: newTotal,
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            // Create purchase record
            const purchaseRef = db.collection('purchases').doc();
            transaction.set(purchaseRef, {
                userId: userId,
                points: pointsToAdd,
                amount: session.amount_total,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                sessionId: session.id,
                status: 'completed',
                paymentIntent: session.payment_intent
            });
        });

        console.log('Transaction completed:', {
            userId,
            points,
            sessionId: session.id
        });
    } catch (error) {
        console.error('Transaction failed:', error);
        throw error;
    }
}

// Debug endpoint (remove in production)
app.get('/api/debug-config', (req, res) => {
    res.json({
        hasStripePublishableKey: !!process.env.STRIPE_PUBLISHABLE_KEY,
        hasStripeSecretKey: !!process.env.STRIPE_SECRET_KEY,
        hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
        nodeEnv: process.env.NODE_ENV
    });
});

// Export for Vercel
module.exports = app;
