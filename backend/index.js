require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const admin = require('firebase-admin')
const port = process.env.PORT || 3000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)

//stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);


const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_URL],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {

    const db = client.db('PlantNet');
    const plantsCollection = db.collection('plants');
    const ordersCollection = db.collection('orders');
    const usersCollection = db.collection('users');
    const sellerRequestsCollection = db.collection('sellerRequest');

    //role Middlewares
    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({email});
      if (user?.role !== 'admin') {
        return res.status(403).send({message: 'Admin only Actions', role: user?.role})
      } 
      next();
    }
    const verifySeller = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({email});
      if (user?.role !== 'seller') {
        return res.status(403).send({message: 'Seller only Actions', role: user?.role})
      } 
      next();
    }

    //save a plant data in db
    app.post('/plants', verifyJWT, verifySeller, async (req, res) => {
      const plantData = req.body;
      console.log(plantData);
      const result = await plantsCollection.insertOne(plantData);
      res.send(result);
    })

    //get all plants from db
    app.get('/plants', async (req, res) => {
      const result = await plantsCollection.find().toArray();
      res.send(result);
    })

    //get single plant from db
    app.get('/plants/:id', async (req, res) => {
      const id = req.params.id;
      const result = await plantsCollection.findOne({ _id: new ObjectId(id) })
      res.send(result);
    })

    //get all orders for a customer by email
    app.get('/orders', verifyJWT,  async (req, res) => {
      const email = req.tokenEmail;
      const result = await ordersCollection.find({ customerEmail: email }).toArray();
      res.send(result);
    })

    //get all orders for a seller by email
    app.get('/manage-orders/:email', verifyJWT, verifySeller, async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection.find({ 'seller.email': email }).toArray();
      res.send(result);
    })

    //get all plants collection for a seller by email
    app.get('/my-inventory/:email', verifyJWT, verifySeller, async (req, res) => {
      const email = req.params.email;
      const result = await plantsCollection.find({ 'seller.email': email }).toArray();
      res.send(result);
    })



    //payment from stripe
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo);

      const session = await stripe.checkout.sessions.create({
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: paymentInfo?.name,
              description: paymentInfo?.description,
              images: [paymentInfo?.image],
            },
            unit_amount: paymentInfo?.price * 100,
          },
          quantity: paymentInfo?.quantity,
        }],
        customer_email: paymentInfo?.customer?.email,
        mode: 'payment',
        metadata: {
          plantId: paymentInfo?.plantId,
          customerEmail: paymentInfo?.customer?.email,
          customerName: paymentInfo?.customer?.name,
        },
        success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/plant/${paymentInfo.plantId}`,
      })
      res.send({ url: session.url })
    })

    app.post('/payment-success', async (req, res) => {
      const { sessionId } = req.body
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      const plant = await plantsCollection.findOne({ _id: new ObjectId(session.metadata.plantId) })
      const order = await ordersCollection.findOne({ transactionId: session.payment_intent })

      if (session.payment_status === 'paid' && plant && !order) {
        // save order data in db
        const orderInfo = {
          plantId: session.metadata.plantId,
          transactionId: session.payment_intent,
          customerEmail: session.metadata.customerEmail,
          customerName: session.metadata.customerName,
          status: 'pending',
          seller: plant.seller,
          name: plant.name,
          category: plant.category,
          quantity: 1,
          price: session.amount_total / 100,
          image: plant?.image,
        }
        const result = await ordersCollection.insertOne(orderInfo)
        // update plant quantity
        await plantsCollection.updateOne(
          { _id: new ObjectId(session.metadata.plantId) },
          { $inc: { quantity: -1 } }
        )

        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,
        })
      }
      res.send({
        transactionId: session.payment_intent,
        orderId: order._id,
      })
    })


    //User API
    app.post('/user', async (req, res) => {
      const userData = req.body;
      // console.log(userData);

      userData.created_at = new Date().toISOString();
      userData.last_logged_in = new Date().toISOString();
      userData.role = 'customer'; 

      const query = { email: userData.email }

      const existingUser = await usersCollection.findOne(query);
      console.log('User Already Exists ----> ', !!existingUser);

      if (existingUser) {
        console.log('Updating User Info...........');
        const result = await usersCollection.updateOne(query,
          {
            $set: {
              last_logged_in: new Date().toISOString(),
            },
          })
          return res.send(result);
      }

      console.log('Saving new user info......');
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    })

    //Get a user role
    app.get('/user/role', verifyJWT , async (req, res) => {
      const email = req.tokenEmail;
      const result = await usersCollection.findOne({email})
      res.send({role: result?.role})
    })

    //save become-seller request
    app.post('/become-seller', verifyJWT, async(req, res) => {
      const email = req.tokenEmail;

      const alreadyExist = await sellerRequestsCollection.findOne({email})
      if(alreadyExist) {
        return res.status(409).send({message: 'Already Requested, please wait.'})
      }

      const result = await sellerRequestsCollection.insertOne({email});
      res.send(result);
    })

    //get all seller requests
    app.get('/seller-requests', verifyJWT, verifyAdmin, async (req, res) => {
      const result = await sellerRequestsCollection.find().toArray();
      res.send(result);
    })
    
    //get all users
    app.get('/users', verifyJWT, verifyAdmin, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection.find({email: {$ne: adminEmail}}).toArray();
      res.send(result);
    })

    //update users role
    app.patch('/update-role', verifyJWT, verifyAdmin, async (req, res) => {
      const {email, role} = req.body;
      const result = await usersCollection.updateOne({email}, {$set: {role}});
      await sellerRequestsCollection.deleteOne({email});
      res.send(result);
    })


    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from Server..')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
