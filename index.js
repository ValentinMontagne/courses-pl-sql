const path = require("path");
const fs = require("fs");
const express = require("express");
const oracledb = require("oracledb");

const app = express();

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
      connectionString: "0.0.0.0:1522/XEPDB1",
    });
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
    nbrTransactions number,
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
    type number(1) CHECK (type IN (0, 1)),
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
      p_account_user_id IN accounts.user_id%TYPE,
      p_account_id OUT accounts.id%TYPE
  ) AS
  BEGIN
      INSERT INTO accounts (name, amount, user_id)
      VALUES (p_account_name, p_account_amount, p_account_user_id)
      RETURNING id INTO p_account_id;
  END;`
  );
  await connection.execute(
    `CREATE OR REPLACE FUNCTION FormatTransactionName(
      p_type IN NUMBER, p_name IN VARCHAR2
    )  
      RETURN VARCHAR2
    IS
      BEGIN
      RETURN 'T' || TO_CHAR(p_type) || '-' || UPPER(p_name);
    END;`
  );
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE execute_transaction (
      p_transactions_name IN transactions.name%TYPE,
      p_transactions_amount IN transactions.amount%TYPE,
      p_transactions_account_id IN transactions.account_id%TYPE,
      p_transactions_type IN transactions.type%TYPE,
      p_transactions_id OUT transactions.id%TYPE
  ) AS
  BEGIN
      INSERT INTO transactions (name, amount, type, account_id)
      VALUES (FormatTransactionName(p_transactions_type, p_transactions_name), p_transactions_amount, p_transactions_type, p_transactions_account_id)
      RETURNING id INTO p_transactions_id;

      IF p_transactions_type = 1 THEN
      UPDATE accounts
      SET nbrTransactions = nbrTransactions + 1, amount = amount + p_transactions_amount
      WHERE accounts.id = p_transactions_account_id;

      ELSIF p_transactions_type = 0 THEN
      UPDATE accounts
      SET nbrTransactions = nbrTransactions + 1, amount = amount - p_transactions_amount
      WHERE accounts.id = p_transactions_account_id;

      END IF;

  END;`
  );
  await connection.execute(
    `	
    
    CREATE OR REPLACE PROCEDURE export_accounts_to_csv(
      f_account_id IN transactions.account_id%TYPE
    ) 
    AS
      v_file UTL_FILE.FILE_TYPE;
      v_line VARCHAR2(32767);
    BEGIN
      v_file := UTL_FILE.FOPEN('EXPORT_DIR', 'accounts.csv', 'W');
      UTL_FILE.PUT_LINE(v_file, 'ID,NAME,AMOUNT');
      
      FOR rec IN (SELECT id, name, amount FROM transactions WHERE account_id = f_account_id) 
      LOOP
        v_line := rec.id || ',' || rec.name || ',' || rec.amount;
      
            UTL_FILE.PUT_LINE(v_file, v_line);
      
      END LOOP;
      UTL_FILE.FCLOSE(v_file);
      EXCEPTION
         WHEN OTHERS THEN
          IF UTL_FILE.IS_OPEN(v_file)
          THEN
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


await connection.execute(`
CREATE OR REPLACE PROCEDURE procedure_budget (
  c_account_id IN VARCHAR2,
  budget IN NUMBER,
  p_last_transaction_id OUT NUMBER
) IS
  c_amount transactions.amount%TYPE;
  c_id transactions.id%TYPE;
  c_previous_id transactions.id%TYPE;
  total_amount NUMBER := 0;

  CURSOR curseur_BUDGET IS
    SELECT id, amount 
    FROM transactions 
    WHERE account_id = c_account_id;

BEGIN
  OPEN curseur_BUDGET;
  LOOP
    FETCH curseur_BUDGET INTO c_id, c_amount;
    EXIT WHEN curseur_BUDGET%NOTFOUND;

    IF total_amount + c_amount > budget THEN
      p_last_transaction_id := c_previous_id;
      EXIT;
    ELSE
      c_previous_id := c_id;
    END IF;
    
    total_amount := total_amount + c_amount;
  END LOOP;
  CLOSE curseur_BUDGET;

  IF total_amount <= budget THEN
    p_last_transaction_id := c_previous_id;
  END IF;
END;
`);

await connection.execute(`
CREATE OR REPLACE TRIGGER trigger_transaction
  AFTER INSERT
  ON transactions
  FOR EACH ROW  
DECLARE

BEGIN
  IF INSERTING THEN
    UPDATE accounts 
    SET amount = amount + :OLD.amount
    WHERE id = :OLD.account_id;
    END IF;

END;
`);
await connection.execute(`
CREATE INDEX idx_transactions_idCompte_date ON transactions (account_id, creation_ts);
`)

  // Insert some data
  const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
  const usersRows = [
    ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
    ["Amélie Dal", "amelie.dal@gmail.com", 0],
  ];
  let usersResult = await connection.executeMany(usersSql, usersRows);
  console.log(usersResult.rowsAffected, "Users rows inserted");
  const accountsSql = `insert into accounts (name, amount, nbrTransactions, user_id) values(:1, :2, :3, :4)`;
  const accountsRows = [["Compte courant", 2000, 0, 1]];
  let accountsResult = await connection.executeMany(accountsSql, accountsRows);
  console.log(accountsResult.rowsAffected, "Accounts rows inserted");
  connection.commit(); // Now query the rows back
}

connectToDatabase().then(() => {
  setupDatabase();
  app.listen(3000, () => {
    console.log("Server started on http://localhost:3000");
  });
});

app.get("/users", async (req, res) => {
  const getUsersSQL = `select * from users`;
  const result = await connection.execute(getUsersSQL);
  res.json(result.rows);
});

app.get("/", async (req, res) => {
  res.render("index"); // Assuming you have an "index.ejs" file in the "views" directory
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
  const createAccountsSQL = `BEGIN
    insert_account(:name, :amount, :user_id, :account_id);
  END;`;
  const result = await connection.execute(createAccountsSQL, {
    name: req.body.name,
    amount: req.body.amount,
    user_id: req.body.user_id,
    account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });
  if (result.outBinds && result.outBinds.account_id) {
    res.redirect(`/views/${req.body.user_id}`);
  } else {
    res.sendStatus(500);
  }
});

app.post("/accounts/:user_id/:account_id/transactions", async (req, res) => {
  const executeTransactionSQL = `BEGIN
    execute_transaction(:name, :amount, :account_id, :type, :transactions_id);
  END;`;
  const result = await connection.execute(executeTransactionSQL, {
    name: req.body.name,
    amount: req.body.amount,
    account_id: req.params.account_id,
    type: req.body.type,
    transactions_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });
  if (result.outBinds && result.outBinds.transactions_id) {
    res.redirect(`/views/${req.params.user_id}/${req.params.account_id}`);
  } else {
    res.sendStatus(500);
  }
});

app.get("/transactions", async (req, res) => {
  const getTransactionsSQL = `select * from transactions`;
  const result = await connection.execute(getTransactionsSQL);
  res.json(result.rows);
});

app.get("/views/:userId/:accountId", async (req, res) => {
  const getCurrentUserSQL = `select * from users where id = :1`;
  const getAccountsSQL = `select * from accounts where id = :2`;
  const getTransactionsSQL = `select * from transactions where account_id = :1`;
  const [currentUser, account, transactions] = await Promise.all([
    connection.execute(getCurrentUserSQL, [req.params.userId]),
    connection.execute(getAccountsSQL, [req.params.accountId]),
    connection.execute(getTransactionsSQL, [req.params.accountId]),
  ]);

  console.log(currentUser, account);
  res.render("transaction-view", {
    currentUser: currentUser.rows[0],
    accounts: account.rows[0],
    transactions: transactions.rows,
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

app.post("/accounts/:accountId/exports", async (req, res) => {
  try {
    const createSvg = `BEGIN
        export_accounts_to_csv(:account_id);
       END;`;

    const result = await connection.execute(createSvg, {
      account_id: req.params.accountId,
    });

      // Ensure the file exists
    if (result) {
      res.status(201).send("File created");
    } else {
      res.status(404).send("File not found");
    }
  } catch (err) {
    console.error("Error exporting accounts to CSV:", err);
    res.sendStatus(500);
  }
});

app.post("/accounts/:accountId/budgets/:amount", async (req, res) => {
  try {
      const getTransactionId = `
      BEGIN
          procedure_budget(:account_id, :amount, :last_transaction_id);
      END;`;

      const binds = {
          account_id: req.params.accountId,
          amount: req.params.amount,
          last_transaction_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
      };

      const result = await connection.execute(getTransactionId, binds);

      res.json({ last_transaction_id: result.outBinds.last_transaction_id });
  } catch (err) {
      console.error("Error cursor budget:", err);
      res.sendStatus(500);
  }
});
