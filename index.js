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
})();

app.get("/", (req, res) => {
  res.send("Inventory Planner API running");
});

app.listen(process.env.PORT || 3000);
