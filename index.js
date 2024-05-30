const path = require("path");
const express = require("express");
const fs = require("fs");
const app = express();
const oracledb = require("oracledb");

app.set("view engine", "ejs");

app.set("views", path.join(__dirname, "views"));

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
    console.error(err);
  }
}

app.post("/accounts/:accountId/exports", async (req, res) => {
  const accountId = req.params.accountId;

  try {
    await connection.execute(`BEGIN export_accounts_to_csv; END;`);
    res.send(`CSV export created for account ${accountId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating CSV export.");
  }
});

app.get("/accounts/:accountId/exports", async (req, res) => {
  const accountId = req.params.accountId;
  const filename = "accounts.csv";
  let fileContent;

  try {
    const result = await connection.execute(
      `BEGIN read_file(:filename, :file_content); END;`,
      {
        filename,
        file_content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB },
      }
    );

    fileContent = await result.outBinds.file_content.getData();
    res.header("Content-Type", "text/csv");
    res.attachment(`account_${accountId}_transactions.csv`);
    res.send(fileContent);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error reading the CSV file.");
  }
});

app.get("/", async (req, res) => {
  res.render("index");
});

app.get("/accounts/:accountId/budgets/:amount", async (req, res) => {
  const accountId = req.params.accountId;
  const budgetAmount = req.params.amount;

  try {
    let cursor;
    const result = await connection.execute(
      `BEGIN get_transactions_until_budget(:accountId, :budgetAmount, :cursor); END;`,
      {
        accountId,
        budgetAmount,
        cursor: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR },
      }
    );

    cursor = result.outBinds.cursor;
    let transactions = [];
    let row;
    let currentAmount = 0;

    while (currentAmount < budgetAmount && (row = await cursor.getRow())) {
      if (row.TYPE == 0) {
        transactions.push(row);
        currentAmount += row.AMOUNT;
      }
    }

    await cursor.close();

    res.json(transactions);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error retrieving transactions by budget.");
  }
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

  console.log(currentUser, accounts);
  res.render("user-view", {
    currentUser: currentUser.rows[0],
    accounts: accounts.rows,
  });
});

app.get("/accounts", async (req, res) => {
  const getUsersSQL = `select * from accounts`;
  const result = await connection.execute(getUsersSQL);

  res.json(result.rows);
});

app.get("/accounts/:userId", async (req, res) => {
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

app.get("/views/:userId/:accountId", async (req, res) => {
  const getCurrentUserSQL = `select * from users where id = :1`;
  const getAccountSQL = `select * from accounts where id = :1`;
  const getTransactionsSQL = `select * from transactions where account_id = :1 order by creation_ts desc`;

  const [currentUser, account, transactions] = await Promise.all([
    connection.execute(getCurrentUserSQL, [req.params.userId]),
    connection.execute(getAccountSQL, [req.params.accountId]),
    connection.execute(getTransactionsSQL, [req.params.accountId]),
  ]);

  console.log(currentUser.rows[0], account.rows[0], transactions.rows);

  res.render("account-view", {
    currentUser: currentUser.rows[0],
    account: account.rows[0],
    transactions: transactions.rows,
  });
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

app.post("/accounts", async (req, res) => {
  const createAccountSQL = `BEGIN
    insert_account(:name, :amount, :user_id);
      END;`;
  const result = await connection.execute(createAccountSQL, {
    name: req.body.name,
    amount: req.body.amount,
    user_id: req.body.user_id,
  });

  console.log(result);
  res.sendStatus(200);
});

app.post("/transactions", async (req, res) => {
  const createTransactionSQL = `BEGIN
    insert_transaction(:name, :amount, :type, :account_id);
    END;`;
  console.log(req.body);
  const result = await connection.execute(createTransactionSQL, {
    name: req.body.name,
    amount: req.body.amount,
    type: req.body.type,
    account_id: req.body.account_id,
  });

  console.log(result);
  res.sendStatus(200);
});

connectToDatabase().then(async () => {
  await setupDatabase();
  app.listen(3000, () => {
    console.log("Server started on http://localhost:3000");
  });
});

async function setupDatabase() {
  await connection.execute(
    `BEGIN
      execute immediate 'drop table transactions CASCADE CONSTRAINTS';
      execute immediate 'drop table accounts CASCADE CONSTRAINTS';
      execute immediate 'drop table users CASCADE CONSTRAINTS';
      exception when others then if sqlcode <> -942 then raise; end if;
      END;`
  );

  await connection.execute(
    `create table users (
          id number generated always as identity,
          name varchar2(256),
          email varchar2(512),
          creation_ts timestamp with time zone default current_timestamp,
          accounts number default 0,
          primary key (id)
        )`
  );

  await connection.execute(
    `create table accounts (
          id number generated always as identity,
          name varchar2(256),
          amount number,
          user_id number,
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
          type number(1),
          account_id number,
          CONSTRAINT fk_account
          FOREIGN KEY (account_id)
          REFERENCES accounts (id),
          creation_ts timestamp with time zone default current_timestamp,
          primary key (id)
      )`
  );

  await connection.execute(
    `CREATE OR REPLACE FUNCTION format_transaction_name (
      p_type IN transactions.type%TYPE,
      p_name IN transactions.name%TYPE
    ) RETURN VARCHAR2 AS
    BEGIN
      RETURN 'T' || p_type || '-' || UPPER(p_name);
    END;`
  );

  await connection.execute(
    `CREATE OR REPLACE PROCEDURE get_transactions_until_budget(
      p_account_id IN NUMBER,
      p_budget_amount IN NUMBER,
      p_cursor OUT SYS_REFCURSOR
    ) AS
    BEGIN
      OPEN p_cursor FOR
          SELECT id, name, amount, type, account_id
          FROM transactions
          WHERE account_id = p_account_id;
      
    EXCEPTION
      WHEN OTHERS THEN
        RAISE_APPLICATION_ERROR(-20001, 'An error occurred: ' || SQLERRM);
    END get_transactions_until_budget;    
    `
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
      p_accounts_amount IN accounts.amount%TYPE,
      p_accounts_user_id IN accounts.user_id%TYPE
  ) AS
  BEGIN
      INSERT INTO accounts (name, amount, user_id)
      VALUES (p_account_name, p_accounts_amount, p_accounts_user_id);
  END;`
  );

  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_transaction (
      p_transaction_name IN transactions.name%TYPE,
      p_transaction_amount IN transactions.amount%TYPE,
      p_transaction_type IN transactions.type%TYPE,
      p_transaction_account_id IN transactions.account_id%TYPE
  ) AS
    v_formatted_name VARCHAR2(256);
  BEGIN
    v_formatted_name := format_transaction_name(p_transaction_type, p_transaction_name);
  
    INSERT INTO transactions (name, amount, type, account_id)
    VALUES (v_formatted_name, p_transaction_amount, p_transaction_type, p_transaction_account_id);
  
    IF p_transaction_type = 1 THEN
        UPDATE accounts
        SET amount = amount + p_transaction_amount
        WHERE id = p_transaction_account_id;
    ELSE
        UPDATE accounts
        SET amount = amount - p_transaction_amount
        WHERE id = p_transaction_account_id;
    END IF;
  
    UPDATE users
    SET accounts = accounts + 1
    WHERE id = (SELECT user_id FROM accounts WHERE id = p_transaction_account_id);
  END;`
  );

  await connection.execute(
    `CREATE OR REPLACE TRIGGER update_account_balance
    	AFTER INSERT OR UPDATE OR DELETE ON transactions
    	FOR EACH ROW
    	BEGIN
    	  IF INSERTING THEN
    	    IF :NEW.type = 1 THEN
    	      UPDATE accounts
    	      SET amount = amount + :NEW.amount
    	      WHERE id = :NEW.account_id;
    	    ELSE
    	      UPDATE accounts
    	      SET amount = amount - :NEW.amount
    	      WHERE id = :NEW.account_id;
    	    END IF;
    	  ELSIF UPDATING THEN
    	    IF :NEW.type = 1 THEN
    	      UPDATE accounts
    	      SET amount = amount + :NEW.amount - :OLD.amount
    	      WHERE id = :NEW.account_id;
    	    ELSE
    	      UPDATE accounts
    	      SET amount = amount - :NEW.amount + :OLD.amount
    	      WHERE id = :NEW.account_id;
    	    END IF;`
  );

  await connection.execute(
    `	
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

  const usersSql = `insert into users (name, email, accounts) values(:1, :2, :3)`;
  const usersRows = [
    ["Valentin Montagne", "contact@vm-it-consulting.com", 0],
    ["Amélie Dal", "amelie.dal@gmail.com", 0],
  ];
  let usersResult = await connection.executeMany(usersSql, usersRows);
  console.log(usersResult.rowsAffected, "Users rows inserted");

  const accountsSql = `insert into accounts (name, amount, user_id) values(:1, :2, :3)`;
  const accountsRows = [
    ["Compte courant", 4500, 1],
    ["Compte epargne", 100000, 1],
    ["Compte courant", 2500, 2],
    ["Compte epargne", 53000, 2],
  ];
  let accountsResult = await connection.executeMany(accountsSql, accountsRows);
  console.log(accountsResult.rowsAffected, "Accounts rows inserted");

  const transactionsSql = `BEGIN
      insert_transaction(:name, :amount, :type, :account_id);
    END;`;
  const transactionsRows = [
    ["loyer", 570, 0, 2],
    ["les apagnans", 2350, 0, 3],
    ["album Theodort", 53000, 0, 2],
    ["jus d'orange premium", 30, 0, 2],
    ["remboursement apagnans", 2350, 0, 2],
    ["remboursement apagnans", 2350, 1, 3],
    ["place maitre gims Zenith Lille", 110.99, 0, 3],
  ];
  let transactionsResult = await connection.executeMany(
    transactionsSql,
    transactionsRows
  );
  console.log("Transactions accepted");

  connection.commit();
}
