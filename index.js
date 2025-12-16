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
    CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      lead_time_days INT DEFAULT 30,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
})();
(async () => {
  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS supplier_id INT
    REFERENCES suppliers(id);
  `);
})();

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id SERIAL PRIMARY KEY,
      purchase_order_id INT REFERENCES purchase_orders(id),
      product_id INT REFERENCES products(id),
      quantity INT NOT NULL
    );
  `);
})();

(async () => {
  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS lead_time_days INT;
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
app.patch("/products/:id/lead-time", async (req, res) => {
  const { id } = req.params;
  const { lead_time_days } = req.body;

  const { rows } = await pool.query(
    `
    UPDATE products
    SET lead_time_days = $1
    WHERE id = $2
    RETURNING *
    `,
    [Number(lead_time_days), id]
  );

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
// Get items for a specific PO
app.get("/purchase-orders/:id/items", async (req, res) => {
  const { id } = req.params;

  const { rows } = await pool.query(`
    SELECT
      poi.product_id,
      p.sku,
      p.name,
      poi.quantity
    FROM purchase_order_items poi
    JOIN products p ON p.id = poi.product_id
    WHERE poi.purchase_order_id = $1
  `, [id]);

  res.json(rows);
});
// Receive a purchase order
app.post("/purchase-orders/:id/receive", async (req, res) => {
  const poId = req.params.id;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Check PO status
    const poCheck = await client.query(
      `SELECT status FROM purchase_orders WHERE id = $1`,
      [poId]
    );

    if (!poCheck.rows.length) {
      throw new Error("PO not found");
    }

    if (poCheck.rows[0].status === "received") {
      throw new Error("PO already received");
    }

    // 2️⃣ Get PO items
    const itemsRes = await client.query(
      `
      SELECT product_id, quantity
      FROM purchase_order_items
      WHERE purchase_order_id = $1
      `,
      [poId]
    );

    // 3️⃣ Update inventory
    for (const item of itemsRes.rows) {
      await client.query(
        `
        UPDATE products
        SET stock = stock + $1
        WHERE id = $2
        `,
        [item.quantity, item.product_id]
      );
    }

    // 4️⃣ Mark PO as received
    await client.query(
      `
      UPDATE purchase_orders
      SET status = 'received', received_at = NOW()
      WHERE id = $1
      `,
      [poId]
    );

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});


// LIST ALL PURCHASE ORDERS
app.get("/purchase-orders", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        po.id,
        po.created_at,
        po.status,
        COUNT(poi.id) AS total_items,
        COALESCE(SUM(poi.quantity), 0) AS total_units
      FROM purchase_orders po
      LEFT JOIN purchase_order_items poi
        ON po.id = poi.purchase_order_id
      GROUP BY po.id
      ORDER BY po.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch purchase orders" });
  }
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
  const { rows } = await pool.query(`
    SELECT
  p.id,
  p.sku,
  p.name,
  p.image_url,
  p.stock,
  p.reorder_point,

  sup.id   AS supplier_id,
  sup.name AS supplier_name,
  sup.lead_time_days,

  COALESCE(SUM(
    CASE 
      WHEN s.sold_at >= NOW() - INTERVAL '30 days'
      THEN s.quantity
    END
  ), 0) / 30.0 AS daily_velocity

FROM products p
LEFT JOIN sales s
  ON p.id = s.product_id
LEFT JOIN suppliers sup
  ON p.supplier_id = sup.id

GROUP BY
  p.id,
  p.sku,
  p.name,
  p.image_url,
  p.stock,
  p.reorder_point,
  sup.id,
  sup.name,
  sup.lead_time_days;
  `);

  const result = rows.map(p => {
    const days_left =
      p.daily_velocity_30 > 0
        ? p.stock / p.daily_velocity_30
        : null;

    let status = "OK";
    if (days_left !== null && days_left <= p.lead_time_days) status = "ORDER NOW";
    else if (
      days_left !== null &&
      days_left <= p.lead_time_days * 1.5
    ) status = "ORDER SOON";

    return {
      ...p,
      days_of_stock: days_left,
      status
    };
  });

  res.json(result);
});

app.post("/purchase-orders/from-dashboard", async (req, res) => {
  const { supplier_id, items } = req.body; 
  // items: [{ product_id, quantity }]

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const poRes = await client.query(
  `
  INSERT INTO purchase_orders (supplier_id, status)
  VALUES ($1, 'open')
  RETURNING id
  `,
  [supplier_id]
);

    const po = poRes.rows[0];

    for (const item of items) {
      await client.query(
        `
        INSERT INTO purchase_order_items
          (purchase_order_id, product_id, quantity)
        VALUES ($1, $2, $3)
        `,
        [po.id, item.product_id, item.quantity]
      );
    }

    await client.query("COMMIT");
    res.json({ purchase_order_id: po.id });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Failed to create PO" });
  } finally {
    client.release();
  }
});

app.get("/purchase-orders/suggestions", async (req, res) => {
  const TARGET_DAYS_COVERAGE = 90;

  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.sku,
      p.name,
      p.image_url,
      p.stock,
      p.reorder_point,
      COALESCE(SUM(s.quantity), 0) / 30.0 AS daily_velocity
    FROM products p
    LEFT JOIN sales s
      ON p.id = s.product_id
     AND s.sold_at >= NOW() - INTERVAL '30 days'
    GROUP BY p.id
  `);

  const suggestions = rows
    .map(p => {
      if (p.daily_velocity <= 0) return null;

      const needed_stock = Math.ceil(p.daily_velocity * TARGET_DAYS_COVERAGE);
      const order_qty = Math.max(needed_stock - p.stock, 0);

      if (order_qty === 0) return null;

      return {
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        image_url: p.image_url,
        current_stock: p.stock,
        daily_velocity: Number(p.daily_velocity),
        suggested_order_quantity: order_qty
      };
    })
    .filter(Boolean);

  res.json(suggestions);
});

const { Parser } = require("json2csv");

app.get("/purchase-orders/suggestions.csv", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      p.sku,
      p.name,
      p.stock AS current_stock,
      COALESCE(SUM(
        CASE 
          WHEN s.sold_at >= NOW() - INTERVAL '30 days'
          THEN s.quantity 
        END
      ), 0) / 30.0 AS daily_velocity,
      GREATEST(
        CEIL(
          (COALESCE(SUM(
            CASE 
              WHEN s.sold_at >= NOW() - INTERVAL '30 days'
              THEN s.quantity 
            END
          ), 0) / 30.0) * 90 - p.stock
        ),
        0
      ) AS suggested_order_quantity
    FROM products p
    LEFT JOIN sales s ON p.id = s.product_id
    GROUP BY p.id
  `);

  const parser = new Parser();
  const csv = parser.parse(rows);

  res.header("Content-Type", "text/csv");
  res.attachment("reorder_suggestions.csv");
  res.send(csv);
});

const csv = require("csv-parser");
const fs = require("fs");
const multer = require("multer");

const upload = multer({ dest: "uploads/" });

app.post("/inventory/import", upload.single("file"), async (req, res) => {
  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", data => results.push(data))
    .on("end", async () => {
      try {
        for (const row of results) {
          await pool.query(
            `
            UPDATE products
            SET
              stock = $1,
              reorder_point = $2
            WHERE sku = $3
            `,
            [
              Number(row.stock),
              Number(row.reorder_point || 0),
              row.sku
            ]
          );
        }

        fs.unlinkSync(req.file.path);
        res.json({ success: true, updated: results.length });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Import failed" });
      }
    });
});



// PO RECOMMENDATIONS
app.get("/purchase-orders/recommendations", async (req, res) => {
  const LEAD_TIME_DAYS = 30;
  const TARGET_DAYS = 60;

  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.sku,
      p.name,
      p.image_url,
      p.stock,

      -- 30-day velocity
      COALESCE(SUM(
        CASE 
          WHEN s.sold_at >= NOW() - INTERVAL '30 days'
          THEN s.quantity 
        END
      ), 0) / 30.0 AS daily_velocity_30

    FROM products p
    LEFT JOIN sales s ON p.id = s.product_id
    GROUP BY p.id
  `);

  const recommendations = rows.map(p => {
    const dailyVelocity = Number(p.daily_velocity_30) || 0;
    const neededStock = dailyVelocity * TARGET_DAYS;
    const recommendedQty = Math.max(
      Math.ceil(neededStock - p.stock),
      0
    );

    return {
      product_id: p.id,
      sku: p.sku,
      name: p.name,
      image_url: p.image_url,
      stock: p.stock,
      daily_velocity_30: dailyVelocity,
      recommended_order_qty: recommendedQty,
      target_days: TARGET_DAYS
    };
  });

  res.json(recommendations);
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
const { supplier_id, items } = req.body;

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
app.post("/purchase-orders/from-suggestion", async (req, res) => {
  const { product_id, quantity, expected_date } = req.body;

  if (!product_id || !quantity) {
    return res.status(400).json({ error: "product_id and quantity required" });
  }

  const { rows } = await pool.query(
    `
    INSERT INTO purchase_orders (product_id, quantity, expected_date, status)
    VALUES ($1, $2, $3, 'open')
    RETURNING *
    `,
    [product_id, quantity, expected_date || null]
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
app.get("/purchase-orders/intelligence", async (req, res) => {
  const LEAD_TIME_DAYS = 30;

  const { rows } = await pool.query(`
    SELECT
      po.id,
      po.product_id,
      p.name,
      p.image_url,
      po.quantity,
      po.status,
      po.expected_date,
      p.stock,
      COALESCE(SUM(s.quantity), 0) / 30.0 AS daily_velocity_30,
      CASE
        WHEN COALESCE(SUM(s.quantity), 0) = 0 THEN NULL
        ELSE p.stock / (COALESCE(SUM(s.quantity), 0) / 30.0)
      END AS days_of_stock,
      CASE
        WHEN po.expected_date < NOW() THEN 'LATE'
        WHEN po.expected_date < NOW() + INTERVAL '7 days' THEN 'AT RISK'
        ELSE 'ON TRACK'
      END AS po_risk
    FROM purchase_orders po
    JOIN products p ON po.product_id = p.id
    LEFT JOIN sales s
      ON p.id = s.product_id
      AND s.sold_at >= NOW() - INTERVAL '30 days'
    GROUP BY po.id, p.id
    ORDER BY po.expected_date ASC
  `);

  res.json(rows);
});


app.get("/", (req, res) => {
  res.send("Inventory Planner API running");
});
app.use(express.static(__dirname));

app.listen(process.env.PORT || 3000);
