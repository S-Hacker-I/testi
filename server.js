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

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
});

// Webhook endpoint, must come before `express.json()` middleware
app.post('/api/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const sig = req.headers['stripe-signature'];
        console.log('💰 Webhook received:', {
            timestamp: new Date().toISOString(),
            signature: sig ? 'present' : 'missing',
            bodyType: typeof req.body,
            eventType: req.body ? JSON.parse(req.body).type : 'unknown'
        });
        
        try {
            const event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );

            console.log('✅ Webhook verified:', {
                type: event.type,
                id: event.id,
                metadata: event.data.object.metadata,
                amount: event.data.object.amount_total
            });

            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                await handleSuccessfulPayment(session);
            }

            res.json({ received: true });
        } catch (err) {
            console.error('❌ Webhook error:', err);
            res.status(400).send(`Webhook Error: ${err.message}`);
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

// Rate limiter for checkout endpoint
const checkoutLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many checkout attempts, please try again later' }
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

// Process successful payment and update Firebase user points
async function handleSuccessfulPayment(session) {
    console.log('💳 Processing payment:', {
        sessionId: session.id,
        metadata: session.metadata,
        amount: session.amount_total
    });

    const { userId, points } = session.metadata;

    if (!userId || !points) {
        console.error('Missing metadata:', session.metadata);
        throw new Error('Missing required metadata');
    }

    const userRef = admin.firestore().collection('users').doc(userId);
    const purchaseRef = userRef.collection('purchases').doc();
    
    try {
        await admin.firestore().runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            
            if (!userDoc.exists) {
                console.error('User not found:', userId);
                throw new Error('User not found');
            }

            const currentPoints = userDoc.data().points || 0;
            const pointsToAdd = parseInt(points, 10);
            const newPoints = currentPoints + pointsToAdd;
            
            console.log('📊 Points update:', {
                userId,
                currentPoints,
                pointsToAdd,
                newPoints
            });

            // Update user points
            transaction.update(userRef, { 
                points: newPoints,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });

            // Create detailed purchase record
            transaction.set(purchaseRef, {
                points: pointsToAdd,
                amount: session.amount_total,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                paymentId: session.payment_intent,
                status: 'completed',
                previousPoints: currentPoints,
                newTotal: newPoints,
                sessionId: session.id,
                customerEmail: session.customer_details?.email,
                paymentMethod: session.payment_method_types?.[0],
                currency: session.currency,
                amountSubtotal: session.amount_subtotal,
                amountTotal: session.amount_total,
                created: new Date(session.created * 1000).toISOString()
            });
        });

        console.log('✅ Transaction completed successfully:', purchaseRef.id);
    } catch (error) {
        console.error('❌ Transaction failed:', error);
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
