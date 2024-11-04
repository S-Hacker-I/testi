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

// Add this function after Firebase initialization
async function initializeFirestore() {
    const db = admin.firestore();
    
    try {
        // Create required collections
        const collections = ['users', 'purchases', 'pointsTransactions', 'failedPayments'];
        
        for (const collectionName of collections) {
            const collectionRef = db.collection(collectionName);
            const snapshot = await collectionRef.limit(1).get();
            
            if (snapshot.empty) {
                console.log(`Creating collection: ${collectionName}`);
                const tempDoc = await collectionRef.add({
                    _temp: true,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                await tempDoc.delete();
            }
        }

        // Create required index
        const indexFields = [
            { fieldPath: 'userId', order: 'ASCENDING' },
            { fieldPath: 'timestamp', order: 'DESCENDING' }
        ];

        try {
            await db.collection('purchases').orderBy('userId').orderBy('timestamp', 'desc').limit(1).get();
        } catch (error) {
            if (error.code === 'failed-precondition') {
                console.log('Creating required index...');
                await admin.firestore().collection('purchases')
                    .doc('_dummy')
                    .set({
                        userId: '_dummy',
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                
                // Wait for index creation
                let indexCreated = false;
                while (!indexCreated) {
                    try {
                        await db.collection('purchases')
                            .orderBy('userId')
                            .orderBy('timestamp', 'desc')
                            .limit(1)
                            .get();
                        indexCreated = true;
                        console.log('Index created successfully');
                    } catch (e) {
                        console.log('Waiting for index creation...');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }
        }

        console.log('Firestore initialization completed');
    } catch (error) {
        console.error('Firestore initialization error:', error);
        throw error;
    }
}

// Update server startup
const PORT = process.env.PORT || 3000;
(async () => {
    try {
        await initializeFirestore();
        
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();

// Add this before your webhook endpoint
app.post('/api/test-webhook', express.json(), async (req, res) => {
    console.log('🧪 Test webhook received:', req.body);
    res.json({ received: true });
});

// Webhook handler
app.post('/api/webhook', 
    express.raw({type: 'application/json'}),
    async (req, res) => {
        const sig = req.headers['stripe-signature'];
        console.log('Webhook received:', {
            signature: sig ? 'present' : 'missing',
            body: req.body ? 'present' : 'missing'
        });

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

            // Send immediate response
            res.json({ received: true });

            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                console.log('Processing checkout session:', {
                    id: session.id,
                    payment_status: session.payment_status
                });
                
                if (session.payment_status === 'paid') {
                    try {
                        await handleSuccessfulPayment(session);
                        console.log('Payment processed successfully');
                    } catch (error) {
                        console.error('Payment processing failed:', {
                            error: error.message,
                            stack: error.stack
                        });
                        
                        const db = admin.firestore();
                        await db.collection('failedPayments').add({
                            sessionId: session.id,
                            error: error.message,
                            stack: error.stack,
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                            metadata: session.metadata
                        });
                    }
                }
            }
        } catch (err) {
            console.error('Webhook Error:', {
                message: err.message,
                stack: err.stack,
                headers: req.headers
            });
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
app.post('/api/create-points-checkout', async (req, res) => {
    try {
        const { points, userId, email } = req.body;

        if (!points || !userId || points < 10 || points > 5000) {
            return res.status(400).json({ error: 'Invalid points amount' });
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

        res.json({ sessionId: session.id });
    } catch (error) {
        console.error('Create checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
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

// Improved handleSuccessfulPayment function
async function handleSuccessfulPayment(session) {
    const { userId, points } = session.metadata;
    const pointsToAdd = parseInt(points, 10);
    const db = admin.firestore();
    
    try {
        // Create collections if they don't exist
        const collections = ['users', 'purchases', 'pointsTransactions'];
        await Promise.all(collections.map(async (collectionName) => {
            const collectionRef = db.collection(collectionName);
            const snapshot = await collectionRef.limit(1).get();
            if (snapshot.empty) {
                // Create a dummy document that we'll delete immediately
                const dummyDoc = await collectionRef.add({ dummy: true });
                await dummyDoc.delete();
            }
        }));

        // Run transaction
        await db.runTransaction(async (transaction) => {
            console.log('Starting transaction for user:', userId);
            
            const userRef = db.collection('users').doc(userId);
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
                // Create user document if it doesn't exist
                transaction.set(userRef, {
                    points: pointsToAdd,
                    created: admin.firestore.FieldValue.serverTimestamp(),
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                const currentPoints = userDoc.data().points || 0;
                transaction.update(userRef, {
                    points: currentPoints + pointsToAdd,
                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            // Create purchase record
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

            // Create points transaction record
            const transactionRef = db.collection('pointsTransactions').doc();
            transaction.set(transactionRef, {
                userId,
                points: pointsToAdd,
                type: 'purchase',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                purchaseId: purchaseRef.id
            });
        });

        console.log(`Successfully processed payment for user ${userId}: ${points} points`);
    } catch (error) {
        console.error('Transaction failed:', error);
        throw error;
    }
}

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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

// Add this endpoint to test webhook configuration
app.get('/api/test-webhook', async (req, res) => {
    try {
        // Create a test event
        const testEvent = {
            id: `evt_test_${Date.now()}`,
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: `cs_test_${Date.now()}`,
                    metadata: {
                        userId: 'test_user',
                        points: '10'
                    },
                    amount_total: 1000
                }
            }
        };

        // Process the test event
        if (testEvent.type === 'checkout.session.completed') {
            await handleSuccessfulPayment(testEvent.data.object);
        }

        res.json({ success: true, message: 'Test webhook processed successfully' });
    } catch (error) {
        console.error('Test webhook failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
