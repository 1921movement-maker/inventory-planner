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
// CREATE product
app.post("/products", async (req, res) => {
  const { sku, name, stock = 0, reorder_point = 0 } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO products (sku, name, stock, reorder_point)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [sku, name, stock, reorder_point]
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


app.get("/", (req, res) => {
  res.send("Inventory Planner API running");
});

app.listen(process.env.PORT || 3000);
