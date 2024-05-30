const path = require("path");
const express = require("express");
const app = express();
const oracledb = require('oracledb');
const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// Set EJS as the view engine
app.set("view engine", "ejs");

// Define the directory where your HTML files (views) are located
app.set("views", path.join(__dirname, "views"));

// Optionally, you can define a static files directory (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));

app.use(express.json());
app.use(express.urlencoded());

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let connection;

async function connectToDatabase() {
    try {
        connection = await oracledb.getConnection({
            user: "admin",
            password: "password",
            connectionString: "0.0.0.0:1525/XEPDB1",
        });
    } catch (err) {
        console.error("Database connection error:", err);
    }
}

async function setupDatabase() {
    try {
        // Setup tables (users, accounts, transactions) and procedures

        await connection.execute(
            `BEGIN
        execute immediate 'drop table users CASCADE CONSTRAINTS';
        execute immediate 'drop table accounts CASCADE CONSTRAINTS';
        execute immediate 'drop table transactions CASCADE CONSTRAINTS';
        exception when others then if sqlcode <> -942 then raise; end if;
      END;`
        );

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
    )`);

        await connection.execute(

            `CREATE OR REPLACE PROCEDURE update_account_balance (
    p_account_id IN accounts.id%TYPE,
    p_new_balance IN accounts.amount%TYPE
) AS
BEGIN
UPDATE accounts
SET amount = p_new_balance
WHERE id = p_account_id;
END;`);

        await connection.execute(`
CREATE OR REPLACE PROCEDURE insert_transaction (
    p_transaction_name IN transactions.name%TYPE,
    p_transaction_amount IN transactions.amount%TYPE,
    p_transaction_type IN transactions.type%TYPE,
    p_account_id IN transactions.account_id%TYPE,
    p_user_id IN transactions.user_id%TYPE
) AS
    v_new_balance NUMBER;
BEGIN
    -- Calcul du nouveau solde en fonction du type de transaction
    IF p_transaction_type = 0 THEN
        SELECT amount INTO v_new_balance FROM accounts WHERE id = p_account_id;
        v_new_balance := v_new_balance - p_transaction_amount;
    ELSE
        SELECT amount INTO v_new_balance FROM accounts WHERE id = p_account_id;
        v_new_balance := v_new_balance + p_transaction_amount;
    END IF;

    -- Insertion de la transaction
    INSERT INTO transactions (name, amount, type, account_id, user_id)
    VALUES (p_transaction_name, p_transaction_amount, p_transaction_type, p_account_id, p_user_id);

    -- Mise à jour du solde du compte
    update_account_balance(p_account_id, v_new_balance);
END;

`
        );

        await connection.execute(
            `CREATE TABLE transactions (
        id NUMBER GENERATED ALWAYS AS IDENTITY,
        name VARCHAR2(256),
        amount NUMBER,
        type NUMBER,
        account_id NUMBER,
        user_id NUMBER,
        creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        FOREIGN KEY (account_id) REFERENCES accounts(id)
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
        p_user_id IN accounts.user_id%TYPE
      ) AS
      BEGIN
        INSERT INTO accounts (name, amount, user_id, transactions)
        VALUES (p_account_name, p_account_amount, p_user_id, 0);
        
        UPDATE users
        SET accounts = accounts + 1
        WHERE id = p_user_id;
      END;`
        );

        await connection.execute(
            `CREATE OR REPLACE FUNCTION format_transaction_name2 (
        p_transaction_name IN transactions.name%TYPE,
        p_transaction_type IN transactions.type%TYPE
      ) RETURN VARCHAR2 IS
      BEGIN
        IF p_transaction_type = 0 THEN
          RETURN 'T0-' || UPPER(p_transaction_name);
        ELSE
          RETURN 'T1-' || UPPER(p_transaction_name);
        END IF;
      END format_transaction_name2;`
        );

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

        connection.commit();
    } catch (err) {
        console.error("Database setup error:", err);
    }
}

// Route pour la racine de l'application
app.get("/", (req, res) => {
    res.render("index");
});

app.get("/views/:userId", async (req, res) => {
    const getCurrentUserSQL = `select * from users where id = :1`;
    const getAccountsSQL = `select * from accounts where user_id = :1`;
    const [currentUser, accounts] = await Promise.all([
        connection.execute(getCurrentUserSQL, [req.params.userId]),
        connection.execute(getAccountsSQL, [req.params.userId]),
    ]);

    console.log(currentUser, accounts);
    res.render("user-view", {
        currentUser: currentUser.rows[0],
        accounts: accounts.rows,
    });
});

// Route pour la vue des transactions
app.get("/views/:userId/:accountId", async (req, res) => {
    try {
        const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1`;
        const getCurrentUserSQL = `select * from users where id = :1`;
        const getAccountsSQL = `select * from accounts where id = :1`;
        const result = await connection.execute(getTransactionsSQL, [Number(req.params.accountId)]);
        const results = await connection.execute(getCurrentUserSQL, [Number(req.params.userId)]);
        const resultss = await connection.execute(getAccountsSQL, [Number(req.params.accountId)]);

        res.render("transactions-view", {
            transactions: result.rows,
            currentUser: results.rows[0],
            currentAccount: resultss.rows[0],

        });
    } catch (err) {
        console.error("Error fetching transactions:", err);
        res.sendStatus(500);
    }
});

// Route pour la création de nouvelles transactions
app.post("/transactions", async (req, res) => {
    try {
        const { name, amount, type, account_id, user_id } = req.body;
        await connection.execute(
            `BEGIN insert_transaction(:name, :amount, :type, :account_id, :user_id); END;`,
            {
                name,
                amount,
                type,
                account_id,
                user_id,
            }
        );
        connection.commit();
        res.redirect(`/views/${user_id}/${account_id}`);
    } catch (err) {
        console.error("Error creating transaction:", err);
        res.sendStatus(500);
    }
});

// Route pour exporter les transactions d'un compte au format CSV
app.post("/accounts/:accountId/exports", async (req, res) => {
    try {
        const accountId = Number(req.params.accountId);
        const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1`;
        const result = await connection.execute(getTransactionsSQL, [accountId]);
        const transactions = result.rows;

        if (transactions.length > 0) {
            const csvWriter = createCsvWriter({
                path: path.join(__dirname, `exports/account_${accountId}_transactions.csv`),
                header: [
                    {id: 'ID', title: 'ID'},
                    {id: 'NAME', title: 'NAME'},
                    {id: 'AMOUNT', title: 'AMOUNT'},
                    {id: 'TYPE', title: 'TYPE'},
                    {id: 'ACCOUNT_ID', title: 'ACCOUNT_ID'},
                    {id: 'USER_ID', title: 'USER_ID'},
                    {id: 'CREATION_TS', title: 'CREATION_TS'}
                ]
            });

            await csvWriter.writeRecords(transactions);
            res.status(200).send('Export completed successfully');
        } else {
            res.status(404).send('No transactions found for the specified account');
        }
    } catch (err) {
        console.error("Error exporting transactions:", err);
        res.sendStatus(500);
    }
});

// Route pour récupérer le fichier CSV généré
app.get("/accounts/:accountId/exports", (req, res) => {
    const accountId = Number(req.params.accountId);
    const filePath = path.join(__dirname, `exports/account_${accountId}_transactions.csv`);
    if (fs.existsSync(filePath)) {
        res.download(filePath, `account_${accountId}_transactions.csv`);
    } else {
        res.status(404).send('Export file not found');
    }
});

connectToDatabase().then(async () => {
    await setupDatabase();
    app.listen(3000, () => {
        console.log("Server started on http://localhost:3000");
    });
});

app.post("/accounts", async (req, res) => {
    try {
        const { name, userId } = req.body;
        await connection.execute(
            `BEGIN insert_account(:name, 0, :userId); END;`,
            { name, userId }
        );
        connection.commit();
        res.redirect(`/views/${userId}`);
    } catch (err) {
        console.error("Error creating account:", err);
        res.sendStatus(500);
    }
});
