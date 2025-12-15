const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// create table on startup
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        sku TEXT UNIQUE,
        name TEXT,
        stock INT DEFAULT 0,
        reorder_point INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("Products table ready");
  } catch (err) {
    console.error("DB init error", err);
  }
})();
// create sales table
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        product_id INT REFERENCES products(id),
        quantity INT NOT NULL,
        sold_at DATE DEFAULT CURRENT_DATE
      );
    `);
    console.log("Sales table ready");
  } catch (err) {
    console.error("Sales table error", err);
  }
})();
(async () => {
  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS image_url TEXT;
  `);
})();

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES products(id),
      quantity INT,
      status TEXT DEFAULT 'DRAFT',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
})();
(async () => {
  await pool.query(`
    ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS expected_date DATE;
  `);
})();

// CREATE product (with image)
app.post("/products", async (req, res) => {
  const {
    sku,
    name,
    stock = 0,
    reorder_point = 0,
    image_url = null
  } = req.body;

  const { rows } = await pool.query(
    `INSERT INTO products (sku, name, stock, reorder_point, image_url)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [sku, name, stock, reorder_point, image_url]
  );

  res.json(rows[0]);
});

// UPDATE product (image, name, sku, etc.)
app.patch("/products/:id", async (req, res) => {
  const { id } = req.params;
  const { image_url } = req.body;

  const { rows } = await pool.query(
    `UPDATE products
     SET image_url = $1
     WHERE id = $2
     RETURNING *`,
    [image_url, id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: "Product not found" });
  }

  res.json(rows[0]);
});
// BULK UPDATE PRODUCT IMAGES
app.patch("/products/images/bulk", async (req, res) => {
  const { updates } = req.body;
  // updates = [{ product_id: 1, image_url: "https://..." }]

  const results = [];

  for (const item of updates) {
    const { rows } = await pool.query(
      `
      UPDATE products
      SET image_url = $1
      WHERE id = $2
      RETURNING id, name, image_url
      `,
      [item.image_url, item.product_id]
    );

    if (rows[0]) results.push(rows[0]);
  }

  res.json({
    updated: results.length,
    products: results
  });
});


// UPDATE stock
app.patch("/products/:id/stock", async (req, res) => {
  const { id } = req.params;
  const { stock } = req.body;
  const { rows } = await pool.query(
    `UPDATE products SET stock=$1 WHERE id=$2 RETURNING *`,
    [stock, id]
  );
  res.json(rows[0]);
});

// LIST items that need reorder
app.get("/inventory/reorder", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM products WHERE stock <= reorder_point`
  );
  res.json(rows);
});
// RECORD sale
app.post("/sales", async (req, res) => {
  const { product_id, quantity } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO sales (product_id, quantity)
     VALUES ($1, $2) RETURNING *`,
    [product_id, quantity]
  );
  res.json(rows[0]);
});
app.get("/inventory/velocity", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.sku,
      p.name,
      p.image_url,
      p.stock,

      -- 7 day velocity
      COALESCE(SUM(CASE WHEN s.sold_at >= NOW() - INTERVAL '7 days' THEN s.quantity END), 0) / 7.0
        AS daily_velocity_7,

      -- 14 day velocity
      COALESCE(SUM(CASE WHEN s.sold_at >= NOW() - INTERVAL '14 days' THEN s.quantity END), 0) / 14.0
        AS daily_velocity_14,

      -- 30 day velocity
      COALESCE(SUM(CASE WHEN s.sold_at >= NOW() - INTERVAL '30 days' THEN s.quantity END), 0) / 30.0
        AS daily_velocity_30,

      -- 90 day velocity
      COALESCE(SUM(CASE WHEN s.sold_at >= NOW() - INTERVAL '90 days' THEN s.quantity END), 0) / 90.0
        AS daily_velocity_90

    FROM products p
    LEFT JOIN sales s ON p.id = s.product_id
    GROUP BY p.id
  `);

  const result = rows.map(r => ({
    ...r,
    days_of_stock_7: r.daily_velocity_7 > 0 ? r.stock / r.daily_velocity_7 : null,
    days_of_stock_14: r.daily_velocity_14 > 0 ? r.stock / r.daily_velocity_14 : null,
    days_of_stock_30: r.daily_velocity_30 > 0 ? r.stock / r.daily_velocity_30 : null,
    days_of_stock_90: r.daily_velocity_90 > 0 ? r.stock / r.daily_velocity_90 : null
  }));

  res.json(result);
});
app.get("/inventory/reorder-status", async (req, res) => {
  const LEAD_TIME_DAYS = 30; // change later per supplier

  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.sku,
      p.name,
      p.image_url,
      p.stock,
      p.reorder_point,

      COALESCE(SUM(CASE 
        WHEN s.sold_at >= NOW() - INTERVAL '30 days' 
        THEN s.quantity END), 0) / 30.0 AS daily_velocity_30

    FROM products p
    LEFT JOIN sales s ON p.id = s.product_id
    GROUP BY p.id
  `);

  const result = rows.map(p => {
    const days_left =
      p.daily_velocity_30 > 0
        ? p.stock / p.daily_velocity_30
        : null;

    let status = "OK";
    if (days_left !== null && days_left <= LEAD_TIME_DAYS) status = "ORDER NOW";
    else if (days_left !== null && days_left <= LEAD_TIME_DAYS * 1.5) status = "ORDER SOON";

    return {
      ...p,
      days_of_stock: days_left,
      status
    };
  });

  res.json(result);
});
app.post("/purchase-orders/suggest", async (req, res) => {
  const { product_id, lead_time_days = 30, buffer_days = 14 } = req.body;

  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.stock,
      COALESCE(SUM(
        CASE WHEN s.sold_at >= NOW() - INTERVAL '30 days'
        THEN s.quantity END
      ), 0) / 30.0 AS daily_velocity
    FROM products p
    LEFT JOIN sales s ON p.id = s.product_id
    WHERE p.id = $1
    GROUP BY p.id
  `, [product_id]);

  const p = rows[0];
  const needed =
    Math.ceil((lead_time_days + buffer_days) * p.daily_velocity - p.stock);

  res.json({
    product_id,
    suggested_quantity: Math.max(needed, 0)
  });
});
app.post("/purchase-orders", async (req, res) => {
  const { product_id, quantity, expected_date } = req.body;

const { rows } = await pool.query(
  `
  INSERT INTO purchase_orders (product_id, quantity, expected_date, status)
  VALUES ($1, $2, $3, 'open')
  RETURNING *
  `,
  [product_id, quantity, expected_date]
);

res.json(rows[0]);

});
app.post("/purchase-orders/:id/receive", async (req, res) => {
  const poId = req.params.id;

  try {
    // 1. Get the purchase order
    const { rows } = await pool.query(
      `SELECT * FROM purchase_orders WHERE id = $1`,
      [poId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "PO not found" });
    }

    const po = rows[0];

    if (po.status === "received") {
      return res.status(400).json({ error: "PO already received" });
    }

    // 2. Update product stock
    await pool.query(
      `UPDATE products
       SET stock = stock + $1
       WHERE id = $2`,
      [po.quantity, po.product_id]
    );

    // 3. Mark PO as received
    await pool.query(
      `UPDATE purchase_orders
       SET status = 'received'
       WHERE id = $1`,
      [poId]
    );

    res.json({
      message: "Inventory received",
      product_id: po.product_id,
      quantity_added: po.quantity
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to receive inventory" });
  }
});

app.post("/purchase-orders/:id/receive", async (req, res) => {
  const { id } = req.params;

  // Get PO
  const poResult = await pool.query(
    `SELECT * FROM purchase_orders WHERE id = $1`,
    [id]
  );

  if (poResult.rows.length === 0) {
    return res.status(404).json({ error: "PO not found" });
  }

  const po = poResult.rows[0];

  // Update product stock
  await pool.query(
    `UPDATE products
     SET stock = stock + $1
     WHERE id = $2`,
    [po.quantity, po.product_id]
  );

  // Update PO status
  await pool.query(
    `UPDATE purchase_orders
     SET status = 'RECEIVED'
     WHERE id = $1`,
    [id]
  );

  res.json({
    message: "Inventory received",
    product_id: po.product_id,
    quantity_added: po.quantity
  });
});


app.get("/", (req, res) => {
  res.send("Inventory Planner API running");
});

app.listen(process.env.PORT || 3000);
