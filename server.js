require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();

// Add this line before other middleware to trust proxy headers from Vercel
app.set('trust proxy', 1);

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
});

// Add this before your webhook endpoint
app.post('/api/test-webhook', express.json(), async (req, res) => {
    console.log('🧪 Test webhook received:', req.body);
    res.json({ received: true });
});

// Enhanced webhook endpoint with better error handling
app.post('/api/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        let event;
        const sig = req.headers['stripe-signature'];
        
        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );
            
            // Immediately acknowledge receipt
            res.json({ received: true });

            // Handle the checkout.session.completed event
            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                try {
                    await handleSuccessfulPayment(session);
                    console.log('Payment processed successfully');
                } catch (error) {
                    console.error('Payment processing failed:', error);
                    // Store failed payment in separate collection
                    await admin.firestore().collection('failedPayments').add({
                        sessionId: session.id,
                        error: error.message,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        metadata: session.metadata
                    });
                }
            }
        } catch (err) {
            console.error('Webhook Error:', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
    }
);

// Other middleware
app.use(express.json());
app.use(cors());
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://js.stripe.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'", "https://api.stripe.com", "https://*.firebaseio.com"],
            frameSrc: ["'self'", "https://js.stripe.com"]
        },
    },
    crossOriginEmbedderPolicy: false
}));

// More specific rate limiter configuration
const checkoutLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit each IP to 10 requests per windowMs
    message: { error: 'Too many checkout attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    // Add a custom handler for when rate limit is exceeded
    handler: (req, res) => {
        console.log('Rate limit exceeded for IP:', req.ip);
        res.status(429).json({
            error: 'Too many checkout attempts, please try again later',
            retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
        });
    },
    // Custom key generator to use both IP and user ID if available
    keyGenerator: (req) => {
        return req.body.userId ? `${req.ip}-${req.body.userId}` : req.ip;
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes for serving HTML files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

// Create points checkout session
app.post('/api/create-points-checkout', checkoutLimiter, async (req, res) => {
    try {
        const { points, userId } = req.body;

        if (!points || !userId || points < 10 || points > 5000) {
            return res.status(400).json({ error: 'Invalid points amount' });
        }

        console.log('Creating checkout session:', { points, userId });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${points} Points Package`,
                        description: `Purchase ${points} points for TikSave`
                    },
                    unit_amount: 10 // 10 cents per point
                },
                quantity: points
            }],
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/dashboard?success=true`,
            cancel_url: `${process.env.BASE_URL}/dashboard?canceled=true`,
            metadata: {
                userId,
                points: points.toString()
            }
        });

        console.log('Checkout session created:', session.id);
        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Improved handleSuccessfulPayment function
async function handleSuccessfulPayment(session) {
    const { userId, points } = session.metadata;
    const pointsToAdd = parseInt(points, 10);
    const db = admin.firestore();
    
    // Run in transaction to ensure data consistency
    await db.runTransaction(async (transaction) => {
        // Get user document
        const userRef = db.collection('users').doc(userId);
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
            throw new Error('User not found');
        }

        // Calculate new points total
        const currentPoints = userDoc.data().points || 0;
        const newPoints = currentPoints + pointsToAdd;

        // Update user points
        transaction.update(userRef, {
            points: newPoints,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });

        // Create purchase record in user's purchases subcollection
        const purchaseRef = userRef.collection('purchases').doc();
        transaction.set(purchaseRef, {
            points: pointsToAdd,
            amount: session.amount_total,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            sessionId: session.id,
            status: 'completed'
        });

        // Also store in main purchases collection for admin tracking
        const mainPurchaseRef = db.collection('purchases').doc();
        transaction.set(mainPurchaseRef, {
            userId,
            points: pointsToAdd,
            amount: session.amount_total,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            sessionId: session.id,
            status: 'completed'
        });
    });

    console.log(`Successfully processed payment for user ${userId}: ${points} points`);
}

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Add this endpoint to serve the publishable key to the client
app.get('/api/config', (req, res) => {
    res.json({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

// Add this endpoint to verify webhook configuration
app.get('/api/webhook-status', async (req, res) => {
    try {
        const webhooks = await stripe.webhookEndpoints.list();
        res.json({
            webhooks: webhooks.data.map(webhook => ({
                id: webhook.id,
                url: webhook.url,
                status: webhook.status,
                enabled_events: webhook.enabled_events
            }))
        });
    } catch (error) {
        console.error('Webhook status error:', error);
        res.status(500).json({ error: 'Failed to get webhook status' });
    }
});
