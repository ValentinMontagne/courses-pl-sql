const path = require("path");
const express = require("express");
const app = express();
const oracledb = require("oracledb");

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let connection;

// Set EJS as the view engine
app.set("view engine", "ejs");

// Define the directory where your HTML files (views) are located
app.set("views", path.join(__dirname, "views"));

// Optionally, you can define a static files directory (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({extended: true}));

async function connectToDatabase() {
    try {
        connection = await oracledb.getConnection({
            user: "admin",
            password: "password",
            connectionString: "0.0.0.0:1521/XEPDB1",
        });
    } catch (err) {
        console.error(err);
    }
}

app.get("/", async (req, res) => {
    res.render("index"); // Assuming you have an "index.ejs" file in the "views" directory
});

app.get("/views/new_account", async (req, res) => {
    res.render("new_account"); // Assuming you have an "index.ejs" file in the "views" directory
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

    console.log(currentUser.rows, accounts.rows);
    res.render("user-view", {
        currentUser: currentUser.rows[0],
        accounts: accounts.rows,
    });
});

app.get("/views/:userId/:accountId/", async (req, res) => {
    const getCurrentUserSQL = `select * from users where id = :1`;
    const getTransactionSQL = `select * from transaction where account_id = :1`;

    const [currentUser, transaction] = await Promise.all([
        connection.execute(getCurrentUserSQL, [req.params.userId]),
        connection.execute(getTransactionSQL, [req.params.accountId]),

    ]);


    console.log(currentUser.rows,transaction.rows);
    res.render("transaction-view", {
        currentUser: currentUser.rows[0],
        transaction: transaction.rows,
    });
});


app.get("/accounts", async (req,res) => {
    const getAccountsSQL = `select * from accounts`;
    const result = await connection.execute(getAccountsSQL)

    res.json(result.rows);

});

app.post("/accounts", async (req,res) => {
   const createAccountSQL = `BEGIN
   insert_account(:name, :amount, :nb_transaction, :user_id, :account_id);
   END;`;
   const result = await connection.execute(createAccountSQL, {
       name: req.body.name,
       amount: req.body.amount,
       nb_transaction: req.body.nb_transaction,
       user_id: req.body.user_id,
       account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER},
    });

    console.log(result);
    if (result.outBinds && result.outBinds.account_id) {
        res.redirect(`/views/${result.outBinds.account_id}`);
    } else {
        res.sendStatus(500);
    }
});

app.get("/transactions", async (req, res) => {
    const getTransactionSQL = `select * from transaction`;
    const result = await connection.execute(getTransactionSQL)

    res.json(result.rows);
})

app.post("/:id/transactions", async (req, res) => {
    const createTransactionSQL = `BEGIN
        insert_transaction(format_transaction_name(:name, :type), :amount, :type, :account_id, :transaction_id);
    END;`;
    console.log(req.body);

    try {
        const result = await connection.execute(createTransactionSQL, {
            name: req.body.name,
            type: req.body.type,
            amount: req.body.amount,
            account_id: req.body.account_id,
            transaction_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER},
        });

        if (result.outBinds && result.outBinds.transaction_id) {
            res.redirect(`/views/${req.params.id}/${req.body.account_id}`);
        } else {
            res.sendStatus(500);
        }
    } catch (error) {
        console.error("Error executing SQL:", error);
        res.sendStatus(500);
    }
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

    console.log(result);
    if (result.outBinds && result.outBinds.user_id) {
        res.redirect(`/views/${result.outBinds.user_id}`);
    } else {
        res.sendStatus(500);
    }
});

connectToDatabase().then(async () => {
    await setupDatabase();
    app.listen(3300, () => {
        console.log("Server started on http://localhost:3300");
    });
});

app.get("/accounts/:accountId/exports")

app.post("/accounts/:accountId/exports")


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
      nb_transaction number,
      user_id number,
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
      type NUMBER(1) CHECK (type IN (0, 1)),
      account_id number,
      CONSTRAINT fk_account
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
        `CREATE OR REPLACE PROCEDURE insert_account (
      p_account_name IN accounts.name%TYPE,
      p_account_amount IN accounts.amount%TYPE,
      p_account_nb_transaction IN accounts.nb_transaction%TYPE,
      p_user_id IN users.id%TYPE,
      p_account_id OUT accounts.id%TYPE
      
  ) AS
  BEGIN
      INSERT INTO accounts (name, amount, nb_transaction, user_id)
      VALUES (p_account_name, p_account_amount, p_account_nb_transaction, p_user_id)
      RETURNING id INTO p_account_id;
  END;`
    );

    await connection.execute(
        `CREATE OR REPLACE PROCEDURE insert_transaction (
      p_transaction_name IN transaction.name%TYPE,
      p_transaction_amount IN transaction.amount%TYPE,
      p_transaction_type IN transaction.type%TYPE,
      p_account_id IN accounts.id%TYPE,
      p_transaction_id OUT transaction.id%TYPE

      
  ) AS
  BEGIN
      INSERT INTO transaction (name, amount, type, account_id)
      VALUES (p_transaction_name, p_transaction_amount, p_transaction_type, p_account_id)
      RETURNING id INTO p_transaction_id;
      
      UPDATE accounts 
      SET amount = CASE 
                   WHEN p_transaction_type = 1 THEN amount + p_transaction_amount
                   ELSE amount - p_transaction_amount 
                   END,
      nb_transaction = nb_transaction + 1
      WHERE id = p_account_id;
      
      
      
      
    
  END;`
    );
    await connection.execute(
        `CREATE OR REPLACE FUNCTION format_transaction_name (
        p_transaction_name IN transaction.name%TYPE,
        p_transaction_type IN transaction.type%TYPE
        ) RETURN VARCHAR2 IS 
        BEGIN
            RETURN 'T' || p_transaction_type || '-' || UPPER(p_transaction_name);
        END;`
    );



    const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
    const usersRows = [
        ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
        ["Amélie Dal", "amelie.dal@gmail.com", 0],
    ];
    let usersResult = await connection.executeMany(usersSql, usersRows);
    console.log(usersResult.rowsAffected, "Users rows inserted");
    const accountsSql = `insert into accounts (name, amount, nb_transaction, user_id) values(:1, :2, :3, :4)`;
    const accountsRows = [["Compte courant : ", 200000, 0, 1]];
    let accountsResult = await connection.executeMany(accountsSql, accountsRows);
    console.log(accountsResult.rowsAffected, "Accounts rows inserted");
    connection.commit(); // Now query the rows back

}

