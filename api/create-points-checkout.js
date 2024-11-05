const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { points, userId, email } = req.body;

        if (!points || !userId || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Calculate price ($0.10 per point)
        const unitAmount = 10; // 10 cents per point

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'TikSave Points',
                        description: `${points} points for TikSave`,
                    },
                    unit_amount: unitAmount,
                },
                quantity: points,
            }],
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.BASE_URL}/dashboard?canceled=true`,
            customer_email: email,
            metadata: {
                userId,
                points: points.toString(),
            },
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ error: error.message });
    }
}; 