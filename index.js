const path = require("path");
const express = require("express");
const app = express();
const oracledb = require("oracledb");
const fs = require("fs");
const createCsvWriter = require("csv-writer").createObjectCsvWriter;

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
      connectionString: "0.0.0.0:1521/XEPDB1",
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
    )`
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
    await connection.execute(
      `CREATE OR REPLACE PROCEDURE export_transactions_to_csv (p_account_id IN NUMBER) IS
      v_file UTL_FILE.FILE_TYPE;
      v_line VARCHAR2(32767);
  BEGIN
  v_file := UTL_FILE.FOPEN('EXPORT_DIR', 'account_' || p_account_id || '_transactions.csv', 'W');

      UTL_FILE.PUT_LINE(v_file, 'ID,NAME,AMOUNT,TYPE,ACCOUNT_ID,USER_ID,CREATION_TS');

      FOR rec IN (SELECT id, name, amount, type, account_id, user_id, creation_ts FROM transactions WHERE account_id = p_account_id) LOOP
          v_line := rec.id || ',' || rec.name || ',' || rec.amount || ',' || rec.type || ',' || rec.account_id || ',' || rec.user_id || ',' || rec.creation_ts;
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
    await connection.execute(`
      CREATE OR REPLACE TRIGGER UPDATE_ACCOUNT_AMOUNT_TRIGGER
      AFTER INSERT OR DELETE ON transactions
      FOR EACH ROW
      DECLARE
        v_amount NUMBER;
      BEGIN 
        IF INSERTING THEN
          IF :NEW.type = 0 THEN
            -- Si c'est une transaction de débit, déduire le montant du compte
            v_amount := :NEW.amount * -1;
          ELSE
            -- Sinon, ajouter le montant au compte
            v_amount := :NEW.amount;
          END IF;
          
          UPDATE accounts
          SET amount = amount + v_amount
          WHERE id = :NEW.account_id;

        ELSIF DELETING THEN
          IF :OLD.type = 0 THEN
            v_amount := :OLD.amount * -1;
          ELSE
            v_amount := :OLD.amount;
          END IF;
          UPDATE accounts
          SET amount = amount - v_amount
          WHERE id = :OLD.account_id;
        END IF;
      END;
    `);

    const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
    const usersRows = [
      ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
      ["Amélie Dal", "amelie.dal@gmail.com", 0],
    ];
    let usersResult = await connection.executeMany(usersSql, usersRows);
    console.log(usersResult.rowsAffected, "Users rows inserted");

    const accountsSql = `insert into accounts (name, amount, user_id) values(:1, :2, :3)`;
    const accountsRows = [["Compte courant", 2000, 1]];
    let accountsResult = await connection.executeMany(
      accountsSql,
      accountsRows
    );
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
app.get("/users", async (req, res) => {
  try {
    const getUsersSQL = `select * from users`;
    const result = await connection.execute(getUsersSQL);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.sendStatus(500);
  }
});

app.post("/users", async (req, res) => {
  try {
    const createUserSQL = `BEGIN
      insert_user(:name, :email, :user_id);
    END;`;
    const result = await connection.execute(createUserSQL, {
      name: req.body.name,
      email: req.body.email,
      user_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });
    connection.commit();
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
  try {
    const getCurrentUserSQL = `select * from users where id = :1`;
    const getAccountsSQL = `select * from accounts where user_id = :1`;
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

app.get("/accounts", async (req, res) => {
  try {
    const getAccountsSQL = `SELECT * FROM accounts`;
    const result = await connection.execute(getAccountsSQL);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching accounts:", err);
    res.sendStatus(500);
  }
});

app.post("/accounts", async (req, res) => {
  try {
    const createAccountSQL = `BEGIN
      insert_account(:name, :amount, :user_id);
    END;`;
    const result = await connection.execute(createAccountSQL, {
      name: req.body.name,
      amount: Number(req.body.amount),
      user_id: req.body.user_id
    });
    
    connection.commit();
    res.redirect(`/views/${req.body.user_id}`);
  } catch (err) {
    console.error("Error creating account:", err);
    res.sendStatus(500);
  }
});

// Route pour la vue des transactions
app.get("/views/:userId/:accountId", async (req, res) => {
  try {
    const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1`;
    const result = await connection.execute(getTransactionsSQL, [
      Number(req.params.accountId),
    ]);
    res.render("transaction-view", {
      transactions: result.rows,
    });
  } catch (err) {
    console.error("Error fetching transactions:", err);
    res.sendStatus(500);
  }
});

// Route pour la création de nouvelles transactions
app.post("/transactions", async (req, res) => {
  try {
    const createTransactionSQL = `
      INSERT INTO transactions (name, amount, type, account_id, user_id)
      VALUES (format_transaction_name2(:1,:2), :3, :4, :5, :6)
    `;
    const result = await connection.execute(createTransactionSQL, [
      //'T' + String(req.body.type) + '-' + req.body.name.toUpperCase(),
      req.body.name,
      Number(req.body.type),
      Number(req.body.amount),
      Number(req.body.type),
      Number(req.body.account_id),
      Number(req.body.user_id),
    ]);
    connection.commit();
    res.redirect(`/views/${req.body.user_id}/${req.body.account_id}`);
  } catch (err) {
    console.error("Error creating transaction:", err);
    res.sendStatus(500);
  }
});
app.delete("/transactions/:id", async (req, res) => {
  try {
    const createTransactionSQL = `
      DELETE FROM transactions WHERE id=:1
    `;
    const result = await connection.execute(createTransactionSQL, [
      req.params.id
    ])
    connection.commit();
    res.sendStatus(200)
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
      // Call the stored procedure to export transactions to CSV in the database
      await connection.execute(`BEGIN export_transactions_to_csv(${accountId}); END;`);
      
      res.status(200).send("Export completed successfully");
    } else {
      res.status(404).send("No transactions found for the specified account");
    }
  } catch (err) {
    console.error("Error exporting transactions:", err);
    res.sendStatus(500);
  }
});


// Route pour récupérer le fichier CSV généré
app.get("/accounts/:accountId/exports", async (req, res) => {
  try {
    const accountId = Number(req.params.accountId);
    const fileName = `account_${accountId}_transactions.csv`;
    let fileContent;
    
    // Call the stored procedure to read the file content
    const result = await connection.execute(
      `BEGIN
        read_file(:filename, :filecontent);
      END;`,
      {
        filename: fileName,
        filecontent: { dir: oracledb.BIND_OUT, type: oracledb.CLOB }
      }
    );

    if (result.outBinds.filecontent) {
      // Send the file content as response
      res.set('Content-Type', 'text/csv');
      const data = await result.outBinds.filecontent.getData();
      res.send(data);
    } else {
      res.status(404).send('Export file not found');
    }
  } catch (err) {
    console.error("Error fetching export file:", err);
    res.sendStatus(500);
  }
});
app.get("/accounts/budgets/:amount", async (req, res) => {
  try {
    const budgetAmount = Number(req.params.amount);
    const accountId = Number(req.query.account_id); // On récupère l'ID du compte à partir des paramètres de requête
    let totalSpent = 0;
    let transactions = [];
    
    // Utilisation d'un curseur pour récupérer les transactions jusqu'à ce que le total dépensé atteigne ou dépasse le montant du budget
    const cursor = await connection.execute(
      `SELECT * FROM transactions WHERE account_id = :1 ORDER BY creation_ts`,
      [accountId],
      { resultSet: true }
    );

    let row;
    while ((row = await cursor.resultSet.getRow())) {
      totalSpent += row.amount;
      if (totalSpent <= budgetAmount) {
        transactions.push(row);
      } else {
        break;
      }
    }

    // Fermeture du curseur
    await cursor.resultSet.close();

    res.status(200).json(transactions);
  } catch (err) {
    console.error("Error fetching transactions for budget:", err);
    res.sendStatus(500);
  }
});
app.post("/transactions", async (req, res) => {
  try {
    const createTransactionSQL = `
      INSERT INTO transactions (name, amount, type, account_id, user_id)
      VALUES (format_transaction_name2(:1,:2), :3, :4, :5, :6)
    `;
    const result = await connection.execute(createTransactionSQL, [
      req.body.name,
      Number(req.body.type),
      Number(req.body.amount),
      Number(req.body.type),
      Number(req.body.account_id),
      Number(req.body.user_id),
    ]);

    // Mettre à jour le montant du compte en banque en fonction de la transaction
    if (Number(req.body.type) === 0) {
      // Si c'est une transaction de type 0, déduire le montant du compte
      await connection.execute(`
        UPDATE accounts
        SET amount = amount - :1
        WHERE id = :2
      `, [Number(req.body.amount), Number(req.body.account_id)]);
    } else {
      // Sinon, ajouter le montant au compte
      await connection.execute(`
        UPDATE accounts
        SET amount = amount + :1
        WHERE id = :2
      `, [Number(req.body.amount), Number(req.body.account_id)]);
    }

    connection.commit();
    res.redirect(`/views/${req.body.user_id}/${req.body.account_id}`);
  } catch (err) {
    console.error("Error creating transaction:", err);
    res.sendStatus(500);
  }
});



connectToDatabase().then(async () => {
  await setupDatabase();
  app.listen(3000, () => {
    console.log("Server started on http://localhost:3000");
  });
});
