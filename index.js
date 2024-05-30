const path = require("path");
const express = require("express");
const app = express();
const oracledb =require("oracledb");
const router = express.Router();
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// Set EJS as the view engine
app.set("view engine", "ejs");

// Define the directory where your HTML files (views) are located
app.set("views", path.join(__dirname, "views"));

// Optionally, you can define a static files directory (CSS, JS, images, etc.)
app.use(express.static(path.join(__dirname, "public")));

app.use(express.json());
app.use(express.urlencoded());


// index.js
///----////////////////////------------------------------------------------

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
    console.error(err);
  }
}

app.get("/", async (req, res) => {
  res.render("index"); // Assuming you have an "index.ejs" file in the "views" directory
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
    // Create new tables, dev only.
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
      primary key (id),
      transactions_count number DEFAULT 0
  )`
);
  await connection.execute(
    `CREATE TABLE transactions (
      id number generated always as identity,
      name varchar2(256),
      amount number,
      type number,
      account_id number,
      creation_ts timestamp with time zone default current_timestamp,
      PRIMARY KEY (id),
      FOREIGN KEY (account_id) REFERENCES accounts (id)
    )`
  );
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
        `CREATE OR REPLACE PROCEDURE add_transaction (
          p_account_id IN transactions.account_id%TYPE,
          p_name IN transactions.name%TYPE,
          p_amount IN transactions.amount%TYPE,
          p_type IN transactions.type%TYPE
      ) AS
          l_new_balance NUMBER;
      BEGIN
          -- Calculer le nouveau solde selon le type de transaction
          SELECT amount INTO l_new_balance FROM accounts WHERE id = p_account_id;
          IF p_type = 1 THEN
              l_new_balance := l_new_balance + p_amount;
          ELSE
              l_new_balance := l_new_balance - p_amount;
          END IF;
      
          -- Mettre à jour le solde du compte
          UPDATE accounts SET amount = l_new_balance, transactions_count = transactions_count + 1
          WHERE id = p_account_id;
      
          -- Insérer la nouvelle transaction
          INSERT INTO transactions (account_id, name, amount, type, creation_ts)
          VALUES (p_account_id, p_name, p_amount, p_type, SYSTIMESTAMP);
      
          COMMIT;
      END;
      `);
      await connection.execute(
        `CREATE OR REPLACE FUNCTION format_transaction_name (
          p_type IN transactions.type%TYPE,
          p_name IN transactions.name%TYPE
      ) RETURN VARCHAR2 AS
          formatted_name VARCHAR2(256);
      BEGIN
          formatted_name := 'T' || p_type || '-' || UPPER(p_name);
          RETURN formatted_name;
      END;
      `
      )
  
    
    await connection.execute(	
      `CREATE OR REPLACE PROCEDURE export_accounts_to_csv IS
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

    )
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
    )
  }
  // ...

connectToDatabase().then(async () => {
    await setupDatabase();
    // Start the server
    app.listen(3000, () => {
      console.log("Server started on http://localhost:3000");
    });
  });

  app.get("/users",async (req,res) => {
    const getUsersSQL = 'select * from users'
    const result= await connection.execute(getUsersSQL);

    res.json(result.rows);  
  })

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
    const getAllAcountsSQL = 'select * from accounts';
    const result = await connection.execute(getAllAcountsSQL);
    res.json(result.rows);
    
  });

  // Route POST pour créer un compte
app.post("/accounts", async (req, res) => {
    const {accountName, initialAmount,userId } = req.body;
    console.log(accountName,initialAmount,userId);
    const createAccountSQL = `
        BEGIN
            INSERT INTO accounts (name, amount, user_id) VALUES (:name, :amount, :user_id) RETURNING id INTO :id;
            UPDATE users SET accounts = accounts + 1 WHERE id = :user_id;
            COMMIT;
        END;
    `;
    const result = await connection.execute(createAccountSQL, {
        name: accountName,
        amount: initialAmount,
        user_id: userId,
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
    });

    if (result) {
        res.redirect(`/views/${userId}`);
    } else {
        res.status(500).send("Erreur lors de la création du compte");
    }
});

// Route pour afficher les transactions d'un compte
app.get('/views/:userId/:accountId', async (req, res) => {
    const { userId, accountId } = req.params;
    const getTransactionsSQL = 'SELECT * FROM transactions WHERE account_id = :accountId';
    const transactions = await connection.execute(getTransactionsSQL, [accountId], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    
    // Affichage de la vue avec les transactions
    res.render('account-view', {
        userId,
        accountId,
        transactions: transactions.rows
    });
});

// Route pour créer une nouvelle transaction
app.post('/views/:userId/:accountId/transactions', async (req, res) => {
    const { userId, accountId } = req.params;
    const { name, amount, type } = req.body;
    
    // Appel de la procédure pour ajouter la transaction et formater son nom
    const addAndFormatTransactionSQL = `
        DECLARE
            formatted_name VARCHAR2(256);
        BEGIN
            formatted_name := format_transaction_name(:type, :name);
            add_transaction(:accountId, formatted_name, :amount, :type);
        END;
    `;
    
    await connection.execute(addAndFormatTransactionSQL, {
        accountId,
        name,
        amount,
        type
    }, { autoCommit: true });

    // Redirection vers la vue des transactions avec la liste mise à jour
    res.redirect(`/views/${userId}/${accountId}`);
});



app.post('/accounts/:accountId/exports', async (req, res) => {
    const accountId = req.params.accountId;
    const csvWriter = createCsvWriter({
        path: `exports/account-${accountId}.csv`,
        header: [
            {id: 'id', title: 'ID'},
            {id: 'name', title: 'NAME'},
            {id: 'amount', title: 'AMOUNT'},
            {id: 'type', title: 'TYPE'},
            {id: 'creation_ts', title: 'CREATED_AT'}
        ]
    });

    try {
        const transactionsQuery = 'SELECT * FROM transactions WHERE account_id = :accountId';
        const result = await connection.execute(transactionsQuery, [accountId], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        await csvWriter.writeRecords(result.rows);
        res.send('CSV file has been created successfully.');
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to create CSV file.');
    }
});
app.get('/accounts/:accountId/exports', (req, res) => {
  const accountId = req.params.accountId;
  const filePath = path.join(__dirname, `exports/account-${accountId}.csv`);
  res.download(filePath, `account-${accountId}-transactions.csv`, (err) => {
      if (err) {
          res.status(500).send('Could not download the file.');
      }
  });
});



