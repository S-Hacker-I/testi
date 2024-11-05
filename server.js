require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin
const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
};

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const app = express();

// Middleware order is important!
// 1. CORS first
app.use(cors({
    origin: ['https://testi-gilt.vercel.app', 'http://localhost:3000'],
    credentials: true
}));

// 2. Raw body parser for Stripe webhook
app.post('/api/webhook', express.raw({type: 'application/json'}));

// 3. JSON parser for other routes
app.use(express.json());

// 4. Static files
app.use(express.static('public'));

// Config endpoint - Get Stripe publishable key
app.get('/api/config', (req, res) => {
    try {
        if (!process.env.STRIPE_PUBLISHABLE_KEY) {
            throw new Error('Stripe publishable key is not configured');
        }
        res.json({
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        console.error('Config endpoint error:', error);
        res.status(500).json({
            error: {
                message: error.message
            }
        });
    }
});

// Checkout session endpoint
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { userId, points, amount } = req.body;

        if (!userId || !points || !amount) {
            return res.status(400).json({
                error: {
                    message: 'Missing required parameters',
                    code: 'INVALID_REQUEST'
                }
            });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            client_reference_id: userId,
            metadata: {
                points: points.toString()
            },
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${points} Points Package`,
                        description: `Purchase ${points} points for your account`
                    },
                    unit_amount: amount * 100 // Convert to cents
                },
                quantity: 1
            }],
            success_url: `${process.env.BASE_URL}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.BASE_URL}/dashboard?canceled=true`
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({
            error: {
                message: error.message || 'Failed to create checkout session',
                code: 'CHECKOUT_ERROR'
            }
        });
    }
});

// Webhook endpoint
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
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
            const session = event.data.object;
            const userId = session.client_reference_id;
            const points = parseInt(session.metadata.points);

            if (!userId || !points) {
                throw new Error('Missing required webhook data');
            }

            // Update user's points in Firestore
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

            console.log(`Successfully updated points for user ${userId}`);
        }
        
        res.json({ received: true });
    } catch (error) {
        console.error('Webhook processing error:', error);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Route handlers for HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        error: {
            message: process.env.NODE_ENV === 'development' ? err.message : 'Internal Server Error',
            code: err.code || 'INTERNAL_ERROR'
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
