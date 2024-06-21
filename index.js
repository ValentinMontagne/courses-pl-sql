const path = require("path");
const express = require("express");
const oracledb = require("oracledb");
const bodyParser = require('body-parser');
const app = express();
const fs = require('fs');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let connection;

async function connectToDatabase() {
    try {
        connection = await oracledb.getConnection({
            user: "admin",
            password: "password",
            connectionString: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=localhost)(PORT=1521))(CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=xepdb1)))",
        });
    } catch (err) {
        console.error(err);
    }
}

app.get("/", async (req, res) => {
    res.render("index");
});

async function createAccount(user_id, accountName, amount) {
    const createAccountSQL = `INSERT INTO accounts (name, amount, user_id) VALUES (:1, :2, :3)`;
    try {
        const result = await connection.execute(createAccountSQL, [accountName, amount, user_id]);
        await connection.commit();
        return result;
    } catch (err) {
        console.error("Error creating account:", err);
        throw err;
    }
}

async function newTransaction(account_id, transactionName, amount, type) {
    const createTransactionSQL = `INSERT INTO transaction (name, amount, account_id, type) VALUES (:name, :amount, :account_id, :type)`;

    try {
        const result = await connection.execute(
            `DECLARE
                formatted_name VARCHAR2(255);
            BEGIN
                format_transaction_name(:name, :type, formatted_name);
                ${createTransactionSQL};
            END;`,
            {
                name: transactionName.toUpperCase(),
                type,
                amount,
                account_id
            }
        );
        await connection.commit();
        return result;
    } catch (err) {
        console.error("Error creating transaction:", err);
        throw err;
    }
}

async function setupDatabase() {
    try {
        await connection.execute(
            `BEGIN
                EXECUTE IMMEDIATE 'DROP TABLE transaction CASCADE CONSTRAINTS';
                EXECUTE IMMEDIATE 'DROP TABLE users CASCADE CONSTRAINTS';
                EXECUTE IMMEDIATE 'DROP TABLE accounts CASCADE CONSTRAINTS';
                EXECUTE IMMEDIATE 'DROP VIEW V1';
                EXCEPTION WHEN OTHERS THEN IF SQLCODE <> -942 THEN RAISE; END IF;
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
                                       CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id),
                                       creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                                       PRIMARY KEY (id)
             )`
        );

        await connection.execute(
            `CREATE TABLE transaction (
                                          id NUMBER GENERATED ALWAYS AS IDENTITY,
                                          name VARCHAR2(256),
                                          amount NUMBER,
                                          type NUMBER,
                                          account_id NUMBER,
                                          CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES accounts (id),
                                          creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                                          PRIMARY KEY (id)
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
            `
            CREATE OR REPLACE PROCEDURE format_transaction_name (
            p_transaction_name IN VARCHAR2,
            p_transaction_type IN NUMBER,
               p_formatted_name OUT VARCHAR2
            )
            IS
                v_prefix VARCHAR2(10);
            BEGIN
            IF p_transaction_type = 0 THEN
                v_prefix := 'T0-'; -- Type 0 pour les transactions sortantes
            ELSE
                v_prefix := 'T1-'; -- Type 1 pour les transactions entrantes
            END IF;
                p_formatted_name := v_prefix || INITCAP(p_transaction_name);
            END;`
        );

        await connection.execute(
            `CREATE OR REPLACE TRIGGER update_account_balance
            AFTER INSERT OR UPDATE OR DELETE ON transaction
            FOR EACH ROW
            BEGIN
            IF INSERTING THEN
                UPDATE accounts SET amount = amount + :new.amount WHERE id = :new.account_id;
            ELSIF UPDATING THEN
                UPDATE accounts SET amount = amount - :old.amount + :new.amount WHERE id = :new.account_id;
            ELSIF DELETING THEN
                UPDATE accounts SET amount = amount - :old.amount WHERE id = :old.account_id;
            END IF;
            END;`
        );

        await connection.execute(
            `CREATE OR REPLACE PROCEDURE export_accounts_to_csv IS tv_file UTL_FILE.FILE_TYPE; v_line VARCHAR2(32767);
            BEGIN
            v_file := UTL_FILE.FOPEN('EXPORT_DIR', 'accounts.csv', 'W');
            UTL_FILE.PUT_LINE(v_file, 'ID,NAME,AMOUNT,USER_ID');
            FOR rec IN (SELECT id, name, amount, user_id FROM accounts) LOOP
            v_line := rec.id || ',' || rec.name || ',' || rec.amount || ',' || rec.user_id;
            UTL_FILE.PUT_LINE(v_file, v_line);
            END LOOP;
            UTL_FILE.FCLOSE(v_file);
            EXCEPTION
            WHEN OTHERS THEN
            IF UTL_FILE.IS_OPEN(v_file) THEN
            UTL_FILE.FCLOSE(v_file);
            END IF;
            RAISE;
            END;
            `
        );

        await connection.execute(
            `CREATE OR REPLACE PROCEDURE read_file(p_filename IN VARCHAR2, p_file_content OUT CLOB) IS
            l_file UTL_FILE.FILE_TYPE;
            l_line VARCHAR2(32767);
            BEGIN
            p_file_content := '';
            l_file := UTL_FILE.FOPEN('EXPORT_DIR', p_filename, 'R');
            LOOP
            BEGIN
            UTL_FILE.GET_LINE(l_file, l_line);
            p_file_content := p_file_content || l_line || CHR(10); -- CHR(10) is newline character
            EXCEPTION
            WHEN NO_DATA_FOUND THEN
            EXIT;
            END;
            END LOOP;
            UTL_FILE.FCLOSE(l_file);
            EXCEPTION
            WHEN UTL_FILE.INVALID_PATH THEN
            RAISE_APPLICATION_ERROR(-20001, 'Invalid file path');
            WHEN UTL_FILE.READ_ERROR THEN
            RAISE_APPLICATION_ERROR(-20004, 'File read error');
            WHEN OTHERS THEN
            RAISE_APPLICATION_ERROR(-20005, 'An error occurred: ' || SQLERRM);
            END read_file;`
        );

        try {
            await connection.execute(`CREATE INDEX account_id_creation_ts_idx ON transaction (account_id, creation_ts)`);
            console.log("Index created successfully");
        } catch (err) {
            console.error("Error creating index:", err);
        }

        try {
            await connection.execute(`CREATE VIEW V1 (amount,creation_ts,account_id,transaction_id) AS SELECT amount,creation_ts,account_id,id FROM transaction`);
            console.log("View created successfully");
        } catch (err) {
            console.error("Error creating view:", err);
        }


        const usersSql = `INSERT INTO users (name, email, accounts) VALUES (:1, :2, :3)`;
        const usersRows = [
            ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
            ["Amélie Dal", "amelie.dal@gmail.com", 0],
        ];
        let usersResult = await connection.executeMany(usersSql, usersRows);
        console.log(usersResult.rowsAffected, "Users rows inserted");

        const accountsSql = `INSERT INTO accounts (name, amount, user_id) VALUES (:1, :2, :3)`;
        const accountsRows = [["Compte courant", 2000, 1]];
        let accountsResult = await connection.executeMany(accountsSql, accountsRows);
        console.log(accountsResult.rowsAffected, "Accounts rows inserted");

        await connection.commit();
    } catch (err) {
        console.error("Error setting up the database:", err);
    }
}

connectToDatabase().then(async () => {
    await setupDatabase();
    app.listen(3000, () => {
        console.log("Server started on http://localhost:3000");
    });
});

app.get("/users", async (req, res) => {
    const getUsersSQL = `SELECT * FROM users`;
    try {
        const result = await connection.execute(getUsersSQL);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching users:", err);
        res.sendStatus(500);
    }
});

app.post("/users", async (req, res) => {
    const createUserSQL = `BEGIN
        insert_user(:name, :email, :user_id);
    END;`;

    try {
        const result = await connection.execute(createUserSQL, {
            name: req.body.name,
            email: req.body.email,
            user_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        });

        if (result.outBinds && result.outBinds.user_id) {
            res.redirect(`/views/${result.outBinds.user_id}`);
        } else {
            res.sendStatus(500);
        }
    } catch (err) {
        console.error("Error creating user:", err);
        res.sendStatus(500);
    }
});

app.get("/views/:userId", async (req, res) => {
    const getCurrentUserSQL = `SELECT * FROM users WHERE id = :1`;
    const getAccountsSQL = `SELECT * FROM accounts WHERE user_id = :1`;

    try {
        const [currentUser, accounts] = await Promise.all([
            connection.execute(getCurrentUserSQL, [req.params.userId]),
            connection.execute(getAccountsSQL, [req.params.userId]),
        ]);

        res.render("user-view", {
            currentUser: currentUser.rows[0],
            accounts: accounts.rows,
        });
    } catch (err) {
        console.error("Error fetching user view:", err);
        res.sendStatus(500);
    }
});

app.get("/transactions", async (req, res) => {
    const getTransactionsSQL = `SELECT * FROM transaction`;
    try {
        const transactions = await connection.execute(getTransactionsSQL);
        res.json(transactions.rows);
    } catch (err) {
        console.error("Error fetching transactions:", err);
        res.sendStatus(500);
    }
});

app.get("/accounts", async (req, res) => {
    const getAccountsSQL = `SELECT * FROM accounts`;
    try {
        const accounts = await connection.execute(getAccountsSQL);
        res.json(accounts.rows);
    } catch (err) {
        console.error("Error fetching accounts:", err);
        res.sendStatus(500);
    }
});

app.get("/views/:userId/:accountId", async (req, res) => {
    const accountId = req.params.accountId;
    const userId = req.params.userId;

    const getTransactionsSQL = `SELECT * FROM transaction WHERE account_id = :accountId`;
    const transactionsResult = await connection.execute(getTransactionsSQL, [accountId]);

    res.render("account-transactions", { accountId, userId, transactions: transactionsResult.rows });
});



app.post("/add-account", async (req, res) => {
    const { name, amount, user_id } = req.body;
    const userId = Number(user_id);

    try {
        const result = await createAccount(userId, name, Number(amount));
        res.redirect(`/views/${userId}`);
    } catch (err) {
        console.error("Error adding account:", err);
        res.sendStatus(500);
    }
});

app.post("/new-transaction", async (req, res) => {
    const { name, amount, account_id, type, user_id } = req.body;
    const userId = Number(user_id);
    const accountId = Number(account_id);
    const transactionType = Number(type);
    const ammount = Number(amount);

    try {
        const result = await newTransaction(accountId, name, ammount, transactionType);
        res.redirect(`/views/${userId}`);
    } catch (err) {
        console.error("Error creating new transaction:", err);
        res.sendStatus(500);
    }
});

app.post("/accounts/:accountId/exports", async (req, res) => {
    const accountId = req.params.accountId;

    const getTransactionsSQL = `SELECT * FROM transaction WHERE account_id = :accountId`;
    try {
        const transactions = await connection.execute(getTransactionsSQL, [accountId]);

        const csvData = transactions.rows.map(transaction => {
            return `${transaction.ID},${transaction.NAME},${transaction.AMOUNT},${transaction.ACCOUNT_ID},${transaction.TYPE}`;
        }).join("\n");

        res.header("Content-Type", "text/csv");
        res.attachment(`transactions_${accountId}.csv`);
        res.send(csvData);
    } catch (err) {
        console.error("Error exporting transactions:", err);
        res.sendStatus(500);
    }
});

app.get("/accounts/:accountId/exports", async (req, res) => {
    const exportsSQL = `BEGIN read_file('accounts.csv', :content);
    END;`;

    const result = await connection.execute(exportsSQL, {
        content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB },
    });

    const data = await result.outBinds.content.getData();

    res.json({ content: data });
});

app.get("/accounts/:accountId/budgets/:amount", async (req, res) => {
    const accountId = req.params.accountId;
    const budgetAmount = req.params.amount;

    try {
        const cursor = await connection.execute(
            `SELECT * FROM transaction WHERE account_id = :accountId ORDER BY transaction_date`,
            [accountId],
            { resultSet: true }
        );

        let totalAmount = 0;
        const transactions = [];

        let row;
        while ((row = await cursor.resultSet.getRow())) {
            const transactionAmount = row.AMOUNT;
            if (totalAmount + transactionAmount <= budgetAmount) {
                transactions.push(row);
                totalAmount += transactionAmount;
            } else {
                break;
            }
        }

        await cursor.resultSet.close();

        res.json(transactions);
    } catch (err) {
        console.error("Error retrieving transactions:", err);
        res.sendStatus(500);
    }
});
