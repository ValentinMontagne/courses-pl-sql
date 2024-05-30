const path = require("path");
const express = require("express");
const oracledb = require("oracledb");
const fs = require("fs");
const app = express();

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

let connection;

async function connectToDatabase() {
  try {
    connection = await oracledb.getConnection({
      user: "admin",
      password: "password",
      connectionString: "0.0.0.0:1528/XEPDB1",
    });
    console.log("Connected to the database");
  } catch (err) {
    console.error("Error connecting to the database:", err);
  }
}

async function setupDatabase() {
  try {
    // Remove old tables, dev only.
    await connection.execute(
      `BEGIN
            execute immediate 'drop table users CASCADE CONSTRAINTS';
            execute immediate 'drop table accounts CASCADE CONSTRAINTS';
            execute immediate 'drop table transactions CASCADE CONSTRAINTS';
            exception when others then if sqlcode <> -942 then raise; end if;
            END;`
    );
    // Create new tables, dev only.
    await connection.execute(
      `CREATE TABLE users (
              id NUMBER GENERATED ALWAYS AS IDENTITY,
              name VARCHAR2(256),
              email VARCHAR2(512),
              creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
              accounts NUMBER DEFAULT 0,
              PRIMARY KEY (id)
            )`
    );
    await connection.execute(
      `CREATE TABLE accounts (
              id NUMBER GENERATED ALWAYS AS IDENTITY,
              name VARCHAR2(256),
              amount NUMBER,
              user_id NUMBER,
              transactions NUMBER DEFAULT 0,
              creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
              CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
              PRIMARY KEY (id)
            )`
    );
    await connection.execute(
      `CREATE TABLE transactions (
                id NUMBER GENERATED ALWAYS AS IDENTITY,
                name VARCHAR2(256),
                amount NUMBER,
                type NUMBER CHECK (type IN (0, 1)), -- 0: Out, 1: In
                account_id NUMBER,
                creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES accounts(id),
                PRIMARY KEY (id)
            )`
    );
    await connection.execute(
      `CREATE OR REPLACE PROCEDURE create_transaction (
                p_transaction_name IN transactions.name%TYPE,
                p_amount IN transactions.amount%TYPE,
                p_type IN transactions.type%TYPE,
                p_account_id IN transactions.account_id%TYPE
            ) AS
            BEGIN
                INSERT INTO transactions (name, amount, type, account_id)
                VALUES (p_transaction_name, p_amount, p_type, p_account_id);

                IF p_type = 1 THEN
                    UPDATE accounts
                    SET amount = amount + p_amount,
                        transactions = transactions + 1
                    WHERE id = p_account_id;
                ELSIF p_type = 0 THEN
                    UPDATE accounts
                    SET amount = amount - p_amount,
                        transactions = transactions + 1
                    WHERE id = p_account_id;
                END IF;
            END;`
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
      `CREATE OR REPLACE PROCEDURE create_account (
                p_account_name IN accounts.name%TYPE,
                p_amount IN accounts.amount%TYPE,
                p_user_id IN accounts.user_id%TYPE
            ) AS
            BEGIN
                INSERT INTO accounts (name, amount, user_id)
                VALUES (p_account_name, p_amount, p_user_id);
                
                UPDATE users
                SET accounts = accounts + 1
                WHERE id = p_user_id;
            END;`
    );
    await connection.execute(
      `	     
      CREATE OR REPLACE PROCEDURE export_transactions_to_csv(p_account_id IN NUMBER) IS
          v_file UTL_FILE.FILE_TYPE;
          v_line VARCHAR2(32767);
      BEGIN
          v_file := UTL_FILE.FOPEN('EXPORT_DIR', 'transactions_account_' || p_account_id || '.csv', 'W');
      
          UTL_FILE.PUT_LINE(v_file, 'ID,NAME,AMOUNT,TYPE,ACCOUNT_ID,CREATION_TS');
      
          FOR rec IN (SELECT id, name, amount, type, account_id, creation_ts FROM transactions WHERE account_id = p_account_id) LOOP
              v_line := rec.id || ',' || rec.name || ',' || rec.amount || ',' || rec.type || ',' || rec.account_id || ',' || rec.creation_ts;
              UTL_FILE.PUT_LINE(v_file, v_line);
          END LOOP;
      
          UTL_FILE.FCLOSE(v_file);
      EXCEPTION
          WHEN OTHERS THEN
              IF UTL_FILE.IS_OPEN(v_file) THEN
                  UTL_FILE.FCLOSE(v_file);
              END IF;
              RAISE;
      END;`
    );
    await connection.execute(
      `	          
      CREATE OR REPLACE PROCEDURE read_file(p_filename IN VARCHAR2, p_file_content OUT CLOB) IS
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
    await connection.execute(
      `CREATE OR REPLACE PROCEDURE fetch_transactions_within_budget (
        p_budget IN NUMBER,
        p_cursor OUT SYS_REFCURSOR
      ) AS
          v_total_amount NUMBER := 0;
      BEGIN
          OPEN p_cursor FOR
              SELECT id, name, amount, type, account_id, creation_ts
              FROM transactions
              ORDER BY creation_ts;
      
          LOOP
              FETCH p_cursor INTO v_id, v_name, v_amount, v_type, v_account_id, v_creation_ts;
              EXIT WHEN p_cursor%NOTFOUND OR v_total_amount + v_amount > p_budget;
      
              v_total_amount := v_total_amount + v_amount;
          END LOOP;
          
          -- Close the cursor if the loop ends early
          IF p_cursor%ISOPEN THEN
              CLOSE p_cursor;
          END IF;
      END fetch_transactions_within_budget;`
    );

    const usersSql = `INSERT INTO users (name, email, accounts) VALUES (:1, :2, :3)`;
    const usersRows = [
      ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
      ["AmÃ©lie Dal", "amelie.dal@gmail.com", 0],
    ];
    await connection.executeMany(usersSql, usersRows);

    const accountsSql = `INSERT INTO accounts (name, amount, user_id) VALUES (:1, :2, :3)`;
    const accountsRows = [["Compte courant", 2000, 1]];
    await connection.executeMany(accountsSql, accountsRows);

    await connection.commit();
    console.log("Database setup completed");
  } catch (err) {
    console.error("Error setting up the database:", err);
  }
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", async (req, res) => {
  res.render("index");
});

app.post("/transactions", async (req, res) => {
  const { name, amount, type, account_id } = req.body;

  console.log("Creating transaction with:", { name, amount, type, account_id });

  const amountNumber = Number(amount);
  const typeNumber = Number(type);
  const accountIdNumber = Number(account_id);

  if (
    typeof name !== "string" ||
    isNaN(amountNumber) ||
    isNaN(typeNumber) ||
    isNaN(accountIdNumber)
  ) {
    return res.status(400).send("Invalid input data");
  }

  const createTransactionSQL = `BEGIN
        create_transaction(:name, :amount, :type, :account_id);
    END;`;
  try {
    await connection.execute(createTransactionSQL, {
      name,
      amount: amountNumber,
      type: typeNumber,
      account_id: accountIdNumber,
    });
    await connection.commit();
    res.redirect(`/views/${accountIdNumber}`);
  } catch (err) {
    console.error("Error creating transaction:", err);
    res.sendStatus(500);
  }
});

app.get("/users", async (req, res) => {
  try {
    const getUsersSQL = `SELECT * FROM users`;
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
  const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE user_id = :1)`;

  try {
    const [currentUser, accounts, transactions] = await Promise.all([
      connection.execute(getCurrentUserSQL, [req.params.userId]),
      connection.execute(getAccountsSQL, [req.params.userId]),
      connection.execute(getTransactionsSQL, [req.params.userId]),
    ]);

    res.render("user-view", {
      currentUser: currentUser.rows[0],
      accounts: accounts.rows,
      transactions: transactions.rows,
    });
  } catch (err) {
    console.error("Error fetching user data:", err);
    res.sendStatus(500);
  }
});

app.post("/accounts", async (req, res) => {
  const { name, amount, user_id } = req.body;

  console.log("Creating account with:", { name, amount, user_id });

  const amountNumber = Number(amount);
  const userIdNumber = Number(user_id);

  if (typeof name !== "string" || isNaN(amountNumber) || isNaN(userIdNumber)) {
    return res.status(400).send("Invalid input data");
  }

  const createAccountSQL = `BEGIN
        create_account(:name, :amount, :user_id);
    END;`;
  try {
    await connection.execute(createAccountSQL, {
      name,
      amount: amountNumber,
      user_id: userIdNumber,
    });
    await connection.commit();
    res.redirect(`/views/${userIdNumber}`);
  } catch (err) {
    console.error("Error creating account:", err);
    res.sendStatus(500);
  }
});

app.post("/accounts/:accountId/exports", async (req, res) => {
  const accountId = Number(req.params.accountId);

  if (isNaN(accountId)) {
    return res.status(400).send("Invalid account ID");
  }

  const exportSQL = `BEGIN
      export_transactions_to_csv(:account_id);
    END;`;

  try {
    await connection.execute(exportSQL, { account_id: accountId });
    await connection.commit();

    const filePath = path.join('/opt/oracle/oradata', `transactions_account_${accountId}.csv`);
    
    // Log file path to ensure it is created
    console.log(`CSV file created at ${filePath}`);
    res.status(200).send("CSV file created successfully");
  } catch (err) {
    console.error("Error exporting transactions:", err);
    res.sendStatus(500);
  }
});

app.get("/accounts/:accountId/exports", async (req, res) => {
  const accountId = Number(req.params.accountId);

  if (isNaN(accountId)) {
    return res.status(400).send("Invalid account ID");
  }

  try {
    const fileName = `transactions_account_${accountId}.csv`;
    let fileContent;

    // Call the PL/SQL procedure to read the file content
    const readFileSyncSQL = `BEGIN
      read_file(:filename, :file_content);
    END;`;

    const bindVars = {
      filename: fileName,
      file_content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB }
    };

    const result = await connection.execute(readFileSyncSQL, bindVars);

    // Retrieve the file content from the result
    fileContent = result.outBinds.file_content;

    // Set the appropriate response headers
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "text/csv");

    // Stream the CLOB data directly to the response
    fileContent.on('error', err => {
      console.error("Error streaming file content:", err);
      res.sendStatus(500);
    });

    fileContent.pipe(res);

  } catch (err) {
    console.error("Error exporting transactions:", err);
    res.sendStatus(500);
  }
});

app.get("/accounts/budgets/:amount", async (req, res) => {
  const budgetAmount = Number(req.params.amount);

  if (isNaN(budgetAmount)) {
    return res.status(400).send("Invalid budget amount");
  }

  const fetchTransactionsSQL = `BEGIN
      fetch_transactions_within_budget(:budget, :cursor);
    END;`;

  try {
    const result = await connection.execute(fetchTransactionsSQL, {
      budget: budgetAmount,
      cursor: { type: oracledb.CURSOR, dir: oracledb.BIND_OUT }
    });

    const cursor = result.outBinds.cursor;
    const transactions = [];
    let row;

    while ((row = await cursor.getRow())) {
      transactions.push(row);
    }

    await cursor.close();

    res.json(transactions);
  } catch (err) {
    console.error("Error fetching transactions within budget:", err);
    res.sendStatus(500);
  }
});

connectToDatabase().then(async () => {
  await setupDatabase();
  app.listen(3200, () => {
    console.log("Server started on http://localhost:3200");
  });
});