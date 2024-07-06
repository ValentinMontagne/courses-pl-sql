	
async function setupDatabase() {
	
    // Remove old tables, dev only.
      
    await connection.execute(
      
      `BEGIN
      
      execute immediate 'drop table users CASCADE CONSTRAINTS';
      
      execute immediate 'drop table accounts CASCADE CONSTRAINTS';
      
      exception when others then if sqlcode <> -942 then raise; end if;
      
      END;`
      
    );
}