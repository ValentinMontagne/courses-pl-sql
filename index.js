const path = require("path");
const express = require("express");
const oracledb = require("oracledb");
const fs = require('fs');
const app = express();

// Set EJS as the view engine
app.set("view engine", "ejs");

// Define the directory where your HTML files (views) are located
app.set("views", path.join(__dirname, "views"));

// Optionally, you can define a static files directory (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));

app.use(express.json());
app.use(express.urlencoded())

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
      execute immediate 'drop table transactions CASCADE CONSTRAINTS';
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
    `create table transactions (
      id number generated always as identity,
      name varchar2(256),
      amount number,
      type number,
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
      INSERT INTO users (name, email, accounts)
      VALUES (p_user_name, p_user_email, 0)
      RETURNING id INTO p_user_id;
  END;`
  );
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_account (
      p_name IN accounts.name%TYPE,
      p_amount IN accounts.amount%TYPE,
      p_user_id IN accounts.user_id%TYPE,
      p_account_id OUT accounts.id%TYPE
    ) AS
    BEGIN
      INSERT INTO accounts (name, amount, user_id, transactions)
      VALUES (p_name, p_amount, p_user_id, 0)
      RETURNING id INTO p_account_id;

      UPDATE users
      SET accounts = accounts + 1
      WHERE id = p_user_id;
      
      COMMIT;
    END;`
  );
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_transaction (
      p_name IN transactions.name%TYPE,
      p_amount IN transactions.amount%TYPE,
      p_type IN transactions.type%TYPE,
      p_account_id IN transactions.account_id%TYPE,
      p_transaction_id OUT transactions.id%TYPE
    ) AS
      v_formatted_name VARCHAR2(256);
    BEGIN
      format_transaction_name(p_name, p_type, v_formatted_name);

      INSERT INTO transactions (name, amount, type, account_id)
      VALUES (v_formatted_name, p_amount, p_type, p_account_id)
      RETURNING id INTO p_transaction_id;
      
      UPDATE accounts
      SET 
          transactions = transactions + 1
      WHERE id = p_account_id;
    END;`
  );
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE format_transaction_name (
    p_name IN VARCHAR2,
    p_type IN NUMBER,
    p_formatted_name OUT VARCHAR2
  ) AS
  BEGIN
    p_formatted_name := 'T' || p_type || '-' || UPPER(p_name);
  END;`
  );
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE export_transactions_to_csv(p_account_id IN NUMBER) IS
    v_file UTL_FILE.FILE_TYPE;
    v_line VARCHAR2(32767);
    v_filename VARCHAR2(255);
BEGIN
    v_filename := 'transactions' || p_account_id || '.csv';
    v_file := UTL_FILE.FOPEN('EXPORT_DIR', v_filename, 'W');
   
    UTL_FILE.PUT_LINE(v_file, 'TRANSACTION_ID,ACCOUNT_ID,AMOUNT,CREATION_TS');
   

    FOR rec IN (SELECT id, account_id, amount, creation_ts FROM transactions WHERE account_id = p_account_id) LOOP
        v_line := rec.id || ',' || rec.account_id || ',' || rec.amount || ',' || TO_CHAR(rec.creation_ts);
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
    `CREATE OR REPLACE PROCEDURE get_transactions_within_budget(
      p_account_id IN NUMBER,
      p_budget IN NUMBER,
      p_transactions OUT SYS_REFCURSOR
  ) IS
  BEGIN
      OPEN p_transactions FOR
          SELECT 
              id, 
              name, 
              amount, 
              type, 
              account_id, 
              creation_ts
          FROM (
              SELECT 
                  id, 
                  name, 
                  amount, 
                  type, 
                  account_id, 
                  creation_ts,
                  SUM(amount) OVER (ORDER BY creation_ts) AS running_total
              FROM 
                  transactions
              WHERE 
                  account_id = p_account_id
                  AND type = 0
          )
          WHERE running_total <= p_budget;
  END;
  ` 
  );
  await connection.execute(
    `CREATE OR REPLACE TRIGGER trg_update_account_balance
    AFTER INSERT OR UPDATE OR DELETE ON transactions
    FOR EACH ROW
    BEGIN
        IF INSERTING THEN
            UPDATE accounts
            SET amount = amount + (CASE WHEN :NEW.type = 1 THEN :NEW.amount ELSE -:NEW.amount END),
                transactions = transactions + 1
            WHERE id = :NEW.account_id;
        END IF;

        IF UPDATING THEN
            UPDATE accounts
            SET amount = amount + 
                (CASE 
                    WHEN :NEW.type = 1 THEN :NEW.amount 
                    ELSE -:NEW.amount 
                END) - 
                (CASE 
                    WHEN :OLD.type = 1 THEN :OLD.amount 
                    ELSE -:OLD.amount 
                END)
            WHERE id = :NEW.account_id;
        END IF;

        IF DELETING THEN
            UPDATE accounts
            SET amount = amount - (CASE WHEN :OLD.type = 1 THEN :OLD.amount ELSE -:OLD.amount END),
                transactions = transactions - 1
            WHERE id = :OLD.account_id;
        END IF;
    END;`
    );
    await connection.execute(
      `CREATE OR REPLACE PROCEDURE generate_fake_transactions(
    p_num_transactions IN NUMBER,
    p_account_id IN NUMBER
) IS
BEGIN
    FOR i IN 1..p_num_transactions LOOP
        INSERT INTO transactions (name, amount, type, account_id, creation_ts)
        VALUES (
            'Transaction ' || i,
            ROUND(DBMS_RANDOM.VALUE(-500, 500), 2),  -- Montant aléatoire entre -500 et 500
            ROUND(DBMS_RANDOM.VALUE(0, 1)),          -- Type aléatoire (0 ou 1)
            p_account_id,
            SYSTIMESTAMP - DBMS_RANDOM.VALUE(0, 365) -- Date aléatoire dans l'année écoulée
        );
    END LOOP;
    
    COMMIT;
END;`
    );
    await connection.execute(`
      CREATE OR REPLACE PROCEDURE get_transactions_secure(
    p_account_id IN NUMBER,
    p_transactions OUT SYS_REFCURSOR
) IS
BEGIN
    OPEN p_transactions FOR
    SELECT 
        id, 
        amount, 
        account_id, 
        creation_ts
    FROM 
        transactions_secure
    WHERE 
        account_id = p_account_id
    ORDER BY 
        creation_ts;
END;
      `
    );
  // Insert some data
  const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
  const usersRows = [
    ["Valentin Montagne", "contact@vm-it-consulting.com", 1],
    ["Amélie Dal", "amelie.dal@gmail.com", 0],
  ];
  let usersResult = await connection.executeMany(usersSql, usersRows);
  console.log(usersResult.rowsAffected, "Users rows inserted");
  const accountsSql = `insert into accounts (name, amount, user_id, transactions) values(:1, :2, :3, :4)`;
  const accountsRows = [["Compte courant", 2000, 1, 0]];
  let accountsResult = await connection.executeMany(accountsSql, accountsRows);
  console.log(accountsResult.rowsAffected, "Accounts rows inserted");
  await connection.execute(`CREATE INDEX idx_account_creation_ts ON transactions(account_id, creation_ts)`);
  await connection.execute(`BEGIN
    generate_fake_transactions(100000, 1);
    END;`);
  connection.commit(); // Now query the rows back
}

// Define a route to render the HTML file
app.get("/", async (req, res) => {
    res.render("index"); // Assuming you have an "index.ejs" file in the "views" directory
});

	
app.get("/users", async (req, res) => {
    const getUsersSQL = `select * from users`;
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
   
    console.log(result);
    if (result.outBinds && result.outBinds.user_id) {
      res.redirect(`/views/${result.outBinds.user_id}`);
    } else {
      res.sendStatus(500);
    }
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

app.get("/accounts", async (req, res) => {
  const getAccountsSQL = `select * from accounts`;
  const result = await connection.execute(getAccountsSQL);
  res.json(result.rows);
});

app.post("/accounts", async (req, res) => {
    const createAccountSQL = `BEGIN
      insert_account(:name, :amount, :user_id, :account_id);
    END;`;
    const result = await connection.execute(createAccountSQL, {
      name: req.body.name,
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

app.get("/views/:userId/:accountId", async (req, res) => {
      const getUserSQL = `SELECT * FROM users WHERE ID = :1`;
      const getAccountSQL = `SELECT * FROM accounts WHERE ID = :1`;
      const getTransactionsSQL = `SELECT * FROM transactions WHERE account_id = :1`;
      
      const [userResult, accountResult, transactionsResult] = await Promise.all([
        connection.execute(getUserSQL, [req.params.userId]),
        connection.execute(getAccountSQL, [req.params.accountId]),
        connection.execute(getTransactionsSQL, [req.params.accountId]),
      ]);
  
      if (userResult.rows.length === 0 || accountResult.rows.length === 0) {
        return res.status(404).send("User or Account not found");
      }
  
      const user = userResult.rows[0];
      const account = accountResult.rows[0];
      const transactions = transactionsResult.rows;
  
      console.log(user, account, transactions);
      res.render("account-view", {
        user,
        account,
        transactions,
      });
  });

app.get("/transactions", async (req, res) => {
    const getTransactionsSQL = `select * from transactions`;
    const result = await connection.execute(getTransactionsSQL);
    res.json(result.rows);
  });

app.post("/transactions", async (req, res) => {
    const createTransactionSQL = `BEGIN
      insert_transaction(:name, :amount, :type, :account_id, :transaction_id);
    END;`;
    const result = await connection.execute(createTransactionSQL, {
      name: req.body.name,
      amount: req.body.amount,
      type: req.body.type,
      account_id: req.body.account_id,
      transaction_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    });
    console.log(result);
    if (result.outBinds && result.outBinds.transaction_id) {
      res.redirect(`/views/${req.body.user_id}/${req.body.account_id}`);
    } else {
      res.sendStatus(500);
    }
  });

app.get('/accounts/:accountId/exports', async (req, res) => {
    const accountId = req.params.accountId;
    const filename = `transactions${accountId}.csv`;
  
	
  const exportsSQL = `BEGIN
  read_file(:filename, :content);
  END;`;

  const result = await connection.execute(exportsSQL, {
    filename: filename,
    content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB },
  });
  const data = await result.outBinds.content.getData();
   
  res.json({ content: data });
  });
  

  app.post('/accounts/:accountId/exports', async (req, res) => {
    const accountId = req.params.accountId;
  
    const exportTransactionsSQL = `
      BEGIN
        export_transactions_to_csv(:accountId);
      END;
    `;
  
    try {
      await connection.execute(exportTransactionsSQL, {
        accountId: accountId
      });
  
      res.status(200).send({ message: 'Transactions exportées avec succès.' });
    } catch (err) {
      console.error(err);
      res.status(500).send({ error: 'Erreur lors de l\'exportation des transactions.' });
    }
  });

  app.get('/accounts/:accountId/budgets/:amount', async (req, res) => {
    const accountId = parseInt(req.params.accountId);
    const budget = parseFloat(req.params.amount);
  
    const getTransactionsSQL = `
      BEGIN
        get_transactions_within_budget(:accountId, :budget, :transactions);
      END;
    `;
  
    try {
      const result = await connection.execute(
        getTransactionsSQL,
        {
          accountId: accountId,
          budget: budget,
          transactions: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR }
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
  
      const transactionCursor = result.outBinds.transactions;
      const transactions = [];
  
      // Fetch rows from the cursor
      let row;
      while ((row = await transactionCursor.getRow())) {
        transactions.push(row);
      }
  
      await transactionCursor.close();
  
      res.status(200).json(transactions);
    } catch (err) {
      console.error(err);
      res.status(500).send({ error: 'Erreur lors de la récupération des transactions.' });
    }
  });
  
  

connectToDatabase().then(async () => {
    await setupDatabase();
    // Start the server
    app.listen(3000, () => {
      console.log("Server started on http://localhost:3000");
    });
});