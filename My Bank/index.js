const path = require("path");
const express = require("express");
const app = express();
const { createObjectCsvWriter } = require('csv-writer');
const oracledb = require("oracledb");

// Set EJS as the view engine
app.set("view engine", "ejs");
 
// Define the directory where your HTML files (views) are located
app.set("views", path.join(__dirname, "views"));
 
// Optionally, you can define a static files directory (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));
 
app.use(express.json());
 
// Define a route to render the HTML file
app.get("/", async (req, res) => {
    res.render("index"); // Assuming you have an "index.ejs" file in the "views" directory
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
  } catch (err) {
    console.error(err);
  }
}

app.use(express.urlencoded({ extended: true }));
 
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

  // console.log(result);
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
 
  // console.log(currentUser, accounts);
  res.render("user-view", {
    currentUser: currentUser.rows[0],
    accounts: accounts.rows,
  });
});

app.get("/views/:userId/:accountId", async (req, res) => {
  const getCurrentUserSQL = `select * from users where id = :1`;
  const getAccountsSQL = `select * from accounts where user_id = :1`;
  const [currentUser, accounts] = await Promise.all([
    connection.execute(getCurrentUserSQL, [req.params.userId]),
    connection.execute(getAccountsSQL, [req.params.userId]),
  ]);
 
  // console.log(currentUser, accounts);
  res.render("user-account-view", {
    currentUser: currentUser.rows[0],
    accounts: accounts.rows,
  });
});
 

app.get("/accounts/:accountId/exports", async (req, res) => {
  const exportsSQL = `BEGIN
      read_file('accounts.csv', :content);
  END;`;
  const result = await connection.execute(exportsSQL, {
      content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB },
  });
  const data = await result.outBinds.content.getData();

  res.json({ content: data });
});


app.post("/accounts/export", async (req, res) => {
  try {
      await connection.execute(`
          DECLARE
              v_file UTL_FILE.FILE_TYPE;
              v_line VARCHAR2(32767);
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
      `);
      res.status(201).send("CSV generated successfully.");
  } catch (err) {
      console.error("Error generating CSV:", err);
      res.status(500).send("Error generating CSV.");
  }
});


app.get("/accounts", async (req, res) => {
  const getAccountsSQL = `select * from accounts`;
  const result = await connection.execute(getAccountsSQL);
 
  res.json(result.rows);
});


app.post("/accounts", async (req, res) => {
  const createUserSQL = `BEGIN
    insert_account(:name, :amount, :user_id, :account_id);
  END;`;
  const result = await connection.execute(createUserSQL, {
    name: req.body.name,
    amount: req.body.amount,
    user_id: req.body.user_id,
    account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });

  console.log(req.body);
  if (req.body.user_id) {
    res.redirect(`/views/${req.body.user_id}`);
  } else {
    res.sendStatus(500);
  }
});

app.post('/create-transaction/', async (req, res) => {
  const { name, amount, type, account_id } = req.body;

  try {
    const result = await connection.execute(
      `BEGIN
         insert_transaction(:name, :amount, :type, :account_id, :transaction_id);
       END;`,
      {
        name: name,
        amount: amount,
        type: type,
        account_id: account_id,
        transaction_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
      }
    );
    console.log(`Inserted transaction with ID: ${result.outBinds.transaction_id}`);

    const userResult = await connection.execute(`SELECT user_id FROM accounts WHERE id = :accountId`, [account_id]);
    const userId = userResult.rows[0]["USER_ID"];
    res.redirect(`/views/${userId}/${account_id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating transaction');
  }
});

// Update an existing transaction
app.put('/update-transaction/:id', async (req, res) => {
  const { id } = req.params;
  const { name, amount, type } = req.body;

  try {
    await connection.execute(
      `UPDATE transactions
       SET name = :name, amount = :amount, type = :type
       WHERE id = :id`,
      { name, amount, type, id }
    );
    res.send('Transaction updated successfully');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating transaction');
  }
});

// Delete a transaction
app.delete('/delete-transaction/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await connection.execute(
      `DELETE FROM transactions WHERE id = :id`,
      { id }
    );
    res.send('Transaction deleted successfully');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting transaction');
  }
});


app.get("/accounts/:accountId/budgets/:amount", async (req, res) => {
  const { accountId, amount } = req.params;

  try {
    const getBudgetTransactionsSQL = `
      DECLARE
        p_transactions SYS_REFCURSOR;
      BEGIN
        get_budget_transactions(:account_id, :budget_amount, p_transactions);
        :cursor := p_transactions;
      END;
    `;

    const result = await connection.execute(getBudgetTransactionsSQL, {
      account_id: accountId,
      budget_amount: amount,
      cursor: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR }
    });

    const cursor = result.outBinds.cursor;
    const rows = await cursor.getRows();
    await cursor.close();

    res.json(rows);
  } catch (err) {
    console.error("Error fetching budget transactions:", err);
    res.status(500).send("Error fetching budget transactions.");
  }
});





connectToDatabase().then(async () => {
  await setupDatabase();
  // Start the server
  app.listen(3000, () => {
    console.log("Server started on http://localhost:3000");
  });
});

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
      transaction_count number,
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
      type NUMBER CHECK (type IN (0, 1)),
      account_id NUMBER,
      creation_ts TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_account FOREIGN KEY (account_id) REFERENCES accounts(id),
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
    `CREATE OR REPLACE PROCEDURE insert_account (
      p_account_name IN accounts.name%TYPE,
      p_account_amount IN accounts.amount%TYPE,
      p_account_user_id IN accounts.user_id%TYPE,
      p_account_id OUT accounts.id%TYPE
    ) AS
    BEGIN
      UPDATE users
      SET accounts = accounts + 1
      WHERE id = p_account_user_id;
      INSERT INTO accounts (name, amount, user_id)
      VALUES (p_account_name, p_account_amount, p_account_user_id)
      RETURNING id INTO p_account_id;
    END;`
  );
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_transaction (
      p_transaction_name IN transactions.name%TYPE,
      p_transaction_amount IN transactions.amount%TYPE,
      p_transaction_type IN transactions.type%TYPE,
      p_account_id IN transactions.account_id%TYPE,
      p_transaction_id OUT transactions.id%TYPE
    ) AS
    BEGIN
      INSERT INTO transactions (name, amount, type, account_id)
      VALUES (p_transaction_name, p_transaction_amount, p_transaction_type, p_account_id)
      RETURNING id INTO p_transaction_id;
    END;    
    `
  );
  await connection.execute(`
    CREATE OR REPLACE PROCEDURE export_accounts_to_csv IS
      v_file UTL_FILE.FILE_TYPE;
      v_line VARCHAR2(32767);
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
  await connection.execute(`
  CREATE OR REPLACE PROCEDURE get_budget_transactions (
    p_account_id IN transactions.account_id%TYPE,
    p_budget_amount IN NUMBER,
    p_transactions OUT SYS_REFCURSOR
  ) AS
    v_total NUMBER := 0;
    v_amount transactions.amount%TYPE;
  BEGIN
    OPEN p_transactions FOR
      SELECT id, name, amount, type, account_id, creation_ts
      FROM (
        SELECT id, name, amount, type, account_id, creation_ts, 
               SUM(amount) OVER (ORDER BY creation_ts) AS running_total
        FROM transactions
        WHERE account_id = p_account_id
      )
      WHERE running_total - amount <= p_budget_amount;
  END;
  
    `
  );
  await connection.execute(`
  CREATE OR REPLACE TRIGGER update_account_balance
    AFTER INSERT OR UPDATE OR DELETE ON transactions
    FOR EACH ROW
    DECLARE
      v_old_amount NUMBER;
      v_new_amount NUMBER;
    BEGIN
      
      IF INSERTING THEN
        v_new_amount := :NEW.amount;

        IF :NEW.type = 1 THEN 
          UPDATE accounts
          SET amount = amount + v_new_amount,
              transaction_count = transaction_count + 1
          WHERE id = :NEW.account_id;
        ELSE 
          UPDATE accounts
          SET amount = amount - v_new_amount,
              transaction_count = transaction_count + 1
          WHERE id = :NEW.account_id;
        END IF;

     
      ELSIF UPDATING THEN
        v_old_amount := :OLD.amount;
        v_new_amount := :NEW.amount;

        IF :OLD.type = 1 THEN 
          UPDATE accounts
          SET amount = amount - v_old_amount
          WHERE id = :OLD.account_id;
        ELSE 
          UPDATE accounts
          SET amount = amount + v_old_amount
          WHERE id = :OLD.account_id;
        END IF;

        IF :NEW.type = 1 THEN 
          UPDATE accounts
          SET amount = amount + v_new_amount
          WHERE id = :NEW.account_id;
        ELSE 
          UPDATE accounts
          SET amount = amount - v_new_amount
          WHERE id = :NEW.account_id;
        END IF;

      
      ELSIF DELETING THEN
        v_old_amount := :OLD.amount;

        IF :OLD.type = 1 THEN 
          UPDATE accounts
          SET amount = amount - v_old_amount,
              transaction_count = transaction_count - 1
          WHERE id = :OLD.account_id;
        ELSE 
          UPDATE accounts
          SET amount = amount + v_old_amount,
              transaction_count = transaction_count - 1
          WHERE id = :OLD.account_id;
        END IF;

      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        
        RAISE_APPLICATION_ERROR(-20001, 'Error in update_account_balance trigger: ' || SQLERRM);
    END;

  
    `
  );
  await connection.execute(`
    CREATE OR REPLACE PROCEDURE read_file(p_filename IN VARCHAR2, p_file_content OUT CLOB) IS
      l_file UTL_FILE.FILE_TYPE;
      l_line VARCHAR2(32767);
    BEGIN
      p_file_content := '';
      l_file := UTL_FILE.FOPEN('EXPORT_DIR', p_filename, 'R');
    
      LOOP
          BEGIN
              UTL_FILE.GET_LINE(l_file, l_line);
              p_file_content := p_file_content || l_line || CHR(10); 
    
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
    END read_file;
    `
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
  connection.commit(); // Now query the rows back
}

