require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

const app = express();

// Important: Raw body parsing for webhooks must come before json middleware
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
        console.log('Webhook event received:', event.type);

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const { userId, points } = session.metadata;
            
            // Update user's points in Firestore
            await db.collection('users').doc(userId).update({
                points: admin.firestore.FieldValue.increment(parseInt(points))
            });
            
            console.log(`Successfully updated points for user ${userId}`);
        }

        res.json({ received: true });
    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

// Regular middleware for other routes
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
});

const db = admin.firestore();

// Create Checkout Session endpoint
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { points, userId, userEmail } = req.body;
        const amount = points * 10; // $0.10 per point = 10 cents

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Points Purchase',
                        description: `${points} points`,
                    },
                    unit_amount: amount,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/success.html`,
            cancel_url: `${process.env.BASE_URL}/`,
            metadata: {
                userId,
                points,
            },
            customer_email: userEmail,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout Session Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get user points endpoint
app.get('/api/points/:userId', async (req, res) => {
    try {
        const doc = await db.collection('users').doc(req.params.userId).get();
        if (!doc.exists) {
            res.json({ points: 0 });
        } else {
            res.json({ points: doc.data().points || 0 });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));