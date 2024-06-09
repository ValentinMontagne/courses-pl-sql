const path = require("path");
const express = require("express");
const oracledb = require("oracledb");
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded());

app.get("/", async (req, res) => {
  res.render("index");
});

app.get("/users", async (req, res) => {
  const getUsersSQL = `SELECT * FROM users`;
  const result = await connection.execute(getUsersSQL);
  res.json(result.rows);
});

app.post("/users", async (req, res) => {
  const createUserSQL = `BEGIN
    insert_user(:name, :email, :user_id);
  END;`;
  const result = await connection.execute(createUserSQL, {
    name: req.body.name,
    email: req.body.email,
    user_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });

  await connection.commit();

  if (result.outBinds && result.outBinds.user_id) {
    res.redirect(`/views/${result.outBinds.user_id}`);
  } else {
    res.sendStatus(500);
  }
});

app.get("/views/:userId", async (req, res) => {
  const getCurrentUserSQL = `SELECT * FROM users WHERE id = :1`;
  const getAccountsSQL = `SELECT * FROM accounts WHERE user_id = :1`;
  const [currentUser, accounts] = await Promise.all([
    connection.execute(getCurrentUserSQL, [req.params.userId]),
    connection.execute(getAccountsSQL, [req.params.userId]),
  ]);

  res.render("user-view", {
    currentUser: currentUser.rows[0],
    accounts: accounts.rows,
  });
});

app.get("/accounts", async (req, res) => {
  const getAccountsSQL = `SELECT * FROM accounts`;
  const result = await connection.execute(getAccountsSQL);
  res.json(result.rows);
});

app.post("/accounts", async (req, res) => {
  const createAccountSQL = `BEGIN
    insert_account(:name, :amount, :user_id, :account_id);
  END;`;
  const result = await connection.execute(createAccountSQL, {
    name: req.body.accountName,
    amount: req.body.amount,
    user_id: req.body.user_id,
    account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });
  console.log(result);
  if (result.outBinds && result.outBinds.account_id) {
    res.redirect(`/views/${req.body.user_id}`);
  } else {
    res.sendStatus(500);
  }
});

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let connection;

async function connectToDatabase() {
  try {
    connection = await oracledb.getConnection({
      user: "admin",
      password: "password",
      connectionString: "0.0.0.0:1525/XEPDB1",
    });
    console.log("Successfully connected to Oracle Database");
  } catch (err) {
    console.error(err);
  }
}

connectToDatabase().then(async () => {
  await setupDatabase();
  app.listen(3000, () => {
    console.log("Server started on http://localhost:3000");
  });
});

async function setupDatabase() {
  await connection.execute(
    `BEGIN
      EXECUTE IMMEDIATE 'DROP TABLE users CASCADE CONSTRAINTS';
      EXECUTE IMMEDIATE 'DROP TABLE accounts CASCADE CONSTRAINTS';
      EXCEPTION
        WHEN OTHERS THEN
          IF SQLCODE <> -942 THEN
            RAISE;
          END IF;
    END;`
  );

  await connection.execute(
    `CREATE TABLE users (
      id NUMBER GENERATED ALWAYS AS IDENTITY,
      name VARCHAR2(256),
      email VARCHAR2(512),
      creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      accounts NUMBER,
      PRIMARY KEY (id)
    )`
  );

  await connection.execute(
    `CREATE TABLE accounts (
      id NUMBER GENERATED ALWAYS AS IDENTITY,
      name VARCHAR2(256),
      amount NUMBER,
      user_id NUMBER,
      CONSTRAINT fk_user
      FOREIGN KEY (user_id)
      REFERENCES users (id),
      creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )`
  );

  await connection.execute(
    `CREATE TABLE transactions (
      id NUMBER GENERATED ALWAYS AS IDENTITY,
      name VARCHAR2(256),
      amount NUMBER,
      type NUMBER,
    )`
  );

  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_user (
      p_user_name IN users.name%TYPE,
      p_user_email IN users.email%TYPE,
      p_user_id OUT users.id%TYPE
    ) AS
    BEGIN
      INSERT INTO users (name, email)
      VALUES (p_user_name, p_user_email)
      RETURNING id INTO p_user_id;
    END;`
  );

  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_account (
      p_account_name IN accounts.name%TYPE,
      p_account_amount IN accounts.amount%TYPE,
      p_user_id IN accounts.user_id%TYPE,
      p_account_id OUT accounts.id%TYPE
    ) AS
    BEGIN
      INSERT INTO accounts (name, amount, user_id)
      VALUES (p_account_name, p_account_amount, p_user_id)
      RETURNING id INTO p_account_id;
    END;`
  );

  await connection.execute(
    `CREATE OR REPLACE PROCEDURE transactions (
      p_transactions_id IN transactions.id%TYPE,
      p_transactions_name IN transactions.name%TYPE,
      p_transactions IN transactions.amount%TYPE
      p_transactions IN transactions.type%TYPE
    ) AS
    BEGIN
      INSERT INTO transactions (id, name, amount, type)
      VALUES (p_transactions_id, p_transactions_name, p_transactions_amount, p_transactions_type);
    END;`
  );

  const usersSql = `INSERT INTO users (name, email, accounts) VALUES(:1, :2, :3)`;
  const usersRows = [
    ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
    ["Amélie Dal", "amelie.dal@gmail.com", 0],
  ];
  await connection.executeMany(usersSql, usersRows);

  const accountsSql = `INSERT INTO accounts (name, amount, user_id) VALUES(:1, :2, :3)`;
  const accountsRows = [
    ["Compte courant", 1000, 1],
    ["Compte épargne", 5000, 2],
  ];
  await connection.executeMany(accountsSql, accountsRows);

  await connection.commit();
}
