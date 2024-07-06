Attention, le container est mappé au port 1522 :
docker run -d -p 1522:1521 -e ORACLE_PASSWORD=oracle -e APP_USER=admin -e APP_USER_PASSWORD=password gvenzl/oracle-xe

cmd pour entrer dans la bdd du container : 
sqlplus sys/oracle@//localhost:1522/XEPDB1 as sysdba

Puis entrer les 2 cmds sql : 
CREATE OR REPLACE DIRECTORY export_dir AS '/opt/oracle/oradata';
GRANT READ, WRITE ON DIRECTORY export_dir TO ADMIN;