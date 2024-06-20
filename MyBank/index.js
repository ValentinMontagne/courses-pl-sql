const path = require("path");
const express = require("express");
const app = express();
const oracledb = require("oracledb");

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

// Set EJS as the view engine
app.set("view engine", "ejs");
// Define the directory where your HTML files (views) are located
app.set("views", path.join(__dirname, "views"));
// Optionally, you can define a static files directory (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded());

// Lancement du serveur après la connexion à la base de données
connectToDatabase().then(async () => {
  await setupDatabase();
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
      transactions number,
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
      type number,
      accounts_id number,
      CONSTRAINT fk_accounts
      FOREIGN KEY (accounts_id)
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
            p_accounts_name IN accounts.name%TYPE,
            p_accounts_amount IN accounts.amount%TYPE,
            p_accounts_user_id IN accounts.user_id%TYPE,
            p_accounts_id OUT accounts.id%TYPE
        ) AS
        BEGIN
            INSERT INTO accounts (name, amount, user_id)
            VALUES (p_accounts_name, p_accounts_amount, p_accounts_user_id)
            RETURNING id INTO p_accounts_id;
        
            UPDATE users
            SET accounts = accounts + 1
            WHERE id = p_accounts_user_id;
        END;`
  );
  await connection.execute(
    `
      CREATE OR REPLACE PROCEDURE format_transactions_name (
      p_transactions_type INT,
      p_transactions_name NVARCHAR2,
      p_transactions_name_out OUT NVARCHAR2
      ) AS
      BEGIN
        p_transactions_name_out := 'T' || TO_CHAR(p_transactions_type) || '-' || UPPER(p_transactions_name);
      END;`
  );
  await connection.execute(
    `CREATE OR REPLACE PROCEDURE insert_transactions (
            p_transactions_name IN transactions.name%TYPE,
            p_transactions_amount IN transactions.amount%TYPE,
            p_transactions_type IN transactions.type%TYPE,
            p_transactions_accounts_id IN transactions.accounts_id%TYPE,
            p_transactions_id OUT transactions.id%TYPE
        ) AS
        BEGIN
            INSERT INTO transactions (name, amount, type,accounts_id)
            VALUES (p_transactions_name, p_transactions_amount, p_transactions_type, p_transactions_accounts_id)
            RETURNING id INTO p_transactions_id;

            IF p_transactions_type = 1 THEN
                UPDATE accounts
                SET amount = amount + p_transactions_amount
                WHERE id = p_transactions_accounts_id;
            ELSE 
                UPDATE accounts
                SET amount = amount - p_transactions_amount
                WHERE id = p_transactions_accounts_id;
            END IF;
            COMMIT;
        END;`
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
  )

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

// Define a route to render the HTML file
app.get("/", async (req, res) => {
  res.render("index"); // Assuming you have an "index.ejs" file in the "views" directory
});

app.get("/accounts/csv", async (req, res) => {
  const fileExecAccount = `BEGIN
	export_accounts_to_csv();
  END;`;

  const resultExecCSV = await connection.execute(fileExecAccount,{}) 

  const exportsSQL = `BEGIN
	read_file('accounts.csv', :content);
  END;`;
  const result = await connection.execute(exportsSQL, {
    content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB },
  });
  const data = await result.outBinds.content.getData();
  res.json({ content: data });
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
  res.render("user-view", {
    currentUser: currentUser.rows[0],
    accounts: accounts.rows,
  });
});

app.get("/views/:userId/:accountId", async (req, res) => {
  const getCurrentUserSQL = `select * from users where id = :1`;
  const getAccountsSQL = `select * from accounts where id = :1`;
  const getTransactionsSQL = `select * from transactions where accounts_id = :1`;
  const [currentUser, accounts, transactions] = await Promise.all([
    connection.execute(getCurrentUserSQL, [req.params.userId]),
    connection.execute(getAccountsSQL, [req.params.accountId]),
    connection.execute(getTransactionsSQL, [req.params.accountId]),
  ]);
  console.log(transactions);
  res.render("account-view", {
    currentUser: currentUser.rows[0],
    accounts: accounts.rows[0],
    transactions: transactions.rows,
  });
});

app.get("/accounts", async (req, res) => {
  const getAccountsSQL = `select * from accounts`;
  const result = await connection.execute(getAccountsSQL);
  res.json(result.rows);
});

app.post("/accounts", async (req, res) => {
  const createAccountSQL = `BEGIN
      insert_accounts(:name, :amount, :user_id, :account_id);
    END;`;
  const result = await connection.execute(createAccountSQL, {
    name: req.body.name,
    amount: req.body.amount,
    user_id: req.body.user_id,
    account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });

  if (result.outBinds) {
    res.redirect(`/views/${req.body.user_id}`);
  } else {
    res.sendStatus(500);
  }
});

app.post("/submit-account", async (req, res) => {
  const { name, amount } = req.body;
  const splitUrl = req.get("Referer").split("/");
  const user_id = splitUrl[splitUrl.length - 1];

  const createAccountSQL = `BEGIN
        insert_accounts(:name, :amount, :user_id, :account_id);
    END;`;
  const result = await connection.execute(createAccountSQL, {
    name: name,
    amount: amount,
    user_id: user_id,
    account_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });

  res.redirect("/views/" + user_id);
});

app.post("/submit-transaction", async (req, res) => {
  const { type, name, amount } = req.body;
  const splitUrl = req.get("Referer").split("/");
  const account_id = splitUrl[splitUrl.length - 1];
  const user_id = splitUrl[splitUrl.length - 2];
  const createAccountSQL = `BEGIN
      insert_transactions(:name, :amount, :type, :account_id, :transaction_id);
  END;`;

  const formatTransactionSQL = `
  BEGIN
  format_transactions_name(:type,:name,:name_out);
  END;
  `;

  const formated_name = await connection.execute(formatTransactionSQL, {
    name: name,
    type: type,
    name_out: { dir: oracledb.BIND_OUT, type: oracledb.STRING },
  });
  console.log(formated_name.outBinds.name_out);
  const result = await connection.execute(createAccountSQL, {
    name: formated_name.outBinds.name_out,
    amount: amount,
    type: type,
    account_id: account_id,
    transaction_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  });

  res.redirect("/views/" + user_id + "/" + account_id);
});

app.get("/transactions", async (req, res) => {
  const getUsersSQL = `select * from transactions`;
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

  if (result.outBinds && result.outBinds.user_id) {
    res.redirect(`/views/${result.outBinds.user_id}`);
  } else {
    res.sendStatus(500);
  }
});
