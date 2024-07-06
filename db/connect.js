import OracleDB from "oracledb";

let connection;
	
	
async function connectToDatabase() {
	
  try {
	
    connection = await OracleDB.getConnection({
	
      user: "admin",
	
      password: "password",
	
      connectionString: "0.0.0.0:1522/XEPDB1",
	
    });
	
    console.log("Successfully connected to Oracle Database");
	
  } catch (err) {
	
    console.error(err);
	
  }
	
}