const path = require("path");
const express = require("express");
const app = express();
const oracledb = require("oracledb");

connectToDatabase().then(async () => {
  await setupDatabase();
  app.listen(4000, () => {
    console.log("Server started on http://localhost:4000");
  });
});

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let connection;

async function connectToDatabase() {
  try {
    connection = await oracledb.getConnection({
      user: "admin",
      password: "password",
      connectionString: "0.0.0.0:1521/XEPDB1",
    });
    console.log("Successfully connected to Oracle Database");
  } catch (err) {
    console.error(err);
  }
}
async function setupDatabase() {
  // Remove old tables, dev only.
  await connection.execute(
    `BEGIN
      execute immediate 'drop table users CASCADE CONSTRAINTS';
      execute immediate 'drop table accounts CASCADE CONSTRAINTS';
      execute immediate 'drop table transaction CASCADE CONSTRAINTS';
      exception when others then if sqlcode <> -942 then raise; end if;
      END;`
  );

  // Create new tables, dev only.
  await connection.execute(
    `create table users (
      id number generated always as identity,
      name varchar2(256),
      email varchar2(512),
      creation_ts timestamp with time zone default current_timestamp,
      accounts number,
      primary key (id)
    )`
  );
  await connection.execute(
    `create table accounts (
      id number generated always as identity,
      name varchar2(256),
      amount number,
      user_id number,
      transactions number,
      CONSTRAINT fk_user
      FOREIGN KEY (user_id)
      REFERENCES users (id),
      creation_ts timestamp with time zone default current_timestamp,
      primary key (id)
  )`
  );
  await connection.execute(
    `create table transaction (
      id number generated always as identity,
      name varchar2(256),
      amount number,
      type number(1) check (type in (0, 1)),
      account_id number,
      CONSTRAINT fk_accounts
      FOREIGN KEY (account_id)
      REFERENCES accounts (id),
      creation_ts timestamp with time zone default current_timestamp,
      primary key (id)
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
    `CREATE OR REPLACE PROCEDURE insert_accounts (
      p_account_name IN accounts.name%TYPE,
      p_account_amount IN accounts.amount%TYPE,
      p_user_id IN accounts.user_id%TYPE
    ) AS
    BEGIN
      INSERT INTO accounts (name, amount, user_id)
      VALUES (p_account_name, p_account_amount, p_user_id);
      UPDATE users SET accounts = accounts + 1 WHERE id = p_user_id;
    END;`
  );
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_transactions (
      p_transaction_name IN transaction.name%TYPE,
      p_transaction_amount IN transaction.amount%TYPE,
      p_transaction_type IN transaction.type%TYPE,
      p_account_id IN transaction.account_id%TYPE
    ) AS
    BEGIN
      INSERT INTO transaction (name, amount, type, account_id)
      VALUES (p_transaction_name, p_transaction_amount, p_transaction_type, p_account_id);
      UPDATE accounts SET transactions = transactions + 1 WHERE id = p_account_id;
    END;
    `
  );
  // Insert some data
  const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
  const usersRows = [
    ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
    ["Amélie Dal", "amelie.dal@gmail.com", 0],
  ];
  let usersResult = await connection.executeMany(usersSql, usersRows);
  console.log(usersResult.rowsAffected, "Users rows inserted");
  const accountsSql = `insert into accounts (name, amount, user_id) values(:1, :2, :3)`;
  const accountsRows = [["Compte courant", 2000, 1]];
  let accountsResult = await connection.executeMany(accountsSql, accountsRows);
  console.log(accountsResult.rowsAffected, "Accounts rows inserted");
  connection.commit(); // Now query the rows back
}

// Set EJS as the view engine
app.set("view engine", "ejs");

// Define the directory where your HTML files (views) are located
app.set("views", path.join(__dirname, "views"));

// Optionally, you can define a static files directory (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));

app.use(express.json());
app.use(express.urlencoded());

// ROUTE GET

app.get("/", async (req, res) => {
  res.render("index"); // Assuming you have an "index.ejs" file in the "views" directory
});
app.get("/users", async (req, res) => {
  const getUsersSQL = `select * from users`;
  const result = await connection.execute(getUsersSQL);

  res.json(result.rows);
});
app.get("/views/:userId", async (req, res) => {
  const getCurrentUserSQL = `select * from users where id = :1`;
  const getAccountsSQL = `select * from accounts where user_id = :1`;
  const [currentUser, accounts] = await Promise.all([
    connection.execute(getCurrentUserSQL, [req.params.userId]),
    connection.execute(getAccountsSQL, [req.params.userId]),
  ]);

  console.log(currentUser.rows[0], accounts);
  res.render("user-view", {
    currentUser: currentUser.rows[0],
    accounts: accounts.rows,
  });
});
app.get("/accounts", async (req, res) => {
  const getAccountsSQL = `select * from accounts`;
  const result = await connection.execute(getAccountsSQL);

  res.json(result.rows);
});

//ROUTE POST

app.post("/users", async (req, res) => {
  const createUserSQL = `BEGIN
      insert_user(:name, :email, :user_id);
    END;`;
  const result = await connection.execute(createUserSQL, {
    name: req.body.name,
    email: req.body.email,
    user_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });

  console.log(result);
  if (result.outBinds && result.outBinds.user_id) {
    res.redirect(`/views/${result.outBinds.user_id}`);
    res.status(200).json("Information bien insérer");
  } else {
    res.sendStatus(500);
  }
});
app.post("/accounts", async (req, res) => {
  const createAccountsSQL = `
    BEGIN
      insert_accounts(:name, :amount, :user_id);
    END;`;
  const result = await connection.execute(createAccountsSQL, {
    name: req.body.name,
    amount: req.body.amount,
    user_id: req.body.user_id,
  });
  console.log(result);
  if (result.rowsAffected && result.rowsAffected > 0) {
    res.status(500).json({ message: "Internal server error" });
  } else {
    console.log(req.body);
    res.redirect(`/views/${req.body.user_id}`);
  }
});
app.post("/transaction", async (req, res) => {
  const createAccountsSQL = `
    BEGIN
      insert_transactions(:name, :amount, :type, :account_id);
    END;`;
  const result = await connection.execute(createAccountsSQL, {
    name: req.body.name,
    amount: req.body.amount,
    type: req.body.type,
    account_id: req.body.account_id
  });
  console.log(result);
  if (result.rowsAffected && result.rowsAffected > 0) {
    res.status(500).json({ message: "Internal server error" });
  } else {
    console.log(req.body);
    res.redirect(`/views/${req.body.user_id}/${req.body.account_id}`);
  }
});
app.get("/views/:userId/:accountId", async (req, res) => {
  const getCurrentUserSQL = `select * from users where id = :1`;
  const getCurrentAccountSQL = `select * from accounts where id = :1`;
  const getTransactionSQL = `select * from transaction where account_id = :1`;
  const [currentUser, accounts,transaction] = await Promise.all([
    connection.execute(getCurrentUserSQL, [req.params.userId]),
    connection.execute(getCurrentAccountSQL, [req.params.accountId]),
    connection.execute(getTransactionSQL, [req.params.accountId]),
  ]);

  console.log(currentUser.rows[0], accounts);
  res.render("transaction-view", {
    currentUser: currentUser.rows[0],
    currentAccount: accounts.rows[0],
    transactions: transaction.rows,
  });
});