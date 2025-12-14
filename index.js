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
// SALES VELOCITY + DAYS OF STOCK
app.get("/inventory/velocity", async (req, res) => {
  const days = Number(req.query.days) || 30;

  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.sku,
      p.name,
      p.stock,
      COALESCE(SUM(s.quantity), 0) / $1 AS daily_velocity,
      CASE
        WHEN COALESCE(SUM(s.quantity), 0) = 0 THEN NULL
        ELSE p.stock / (COALESCE(SUM(s.quantity), 0) / $1)
      END AS days_of_stock
    FROM products p
    LEFT JOIN sales s
      ON p.id = s.product_id
      AND s.sold_at >= CURRENT_DATE - INTERVAL '1 day' * $1
    GROUP BY p.id
  `, [days]);

  res.json(rows);
});
app.get("/inventory/velocity", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.sku,
      p.name,
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
  const { product_id, quantity } = req.body;

  const { rows } = await pool.query(
    `INSERT INTO purchase_orders (product_id, quantity)
     VALUES ($1,$2) RETURNING *`,
    [product_id, quantity]
  );

  res.json(rows[0]);
});


app.get("/", (req, res) => {
  res.send("Inventory Planner API running");
});

app.listen(process.env.PORT || 3000);
