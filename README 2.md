`colima start --arch x86_64 --memory 4 --runtime docker`
`docker run -d -p 1521:1521 -e ORACLE_PASSWORD=oracle -e APP_USER=admin -e APP_USER_PASSWORD=password gvenzl/oracle-xe`
`docker exec -it <nom du conteneur> /bin/bash`
`sqlplus sys/oracle@//localhost/XEPDB1 as sysdba`
`CREATE OR REPLACE DIRECTORY export_dir AS '/opt/oracle/oradata'; GRANT READ, WRITE ON DIRECTORY export_dir TO ADMIN`



`docker cp measure_performance.sql 44eee22614c0:/measure_performance.sql`
`docker exec -it <nom du conteneur> /bin/bash`
`sqlplus admin/password@localhost/XEPDB1 @/measure_performance.sql`
AVEC  -> 00:00:23.45  |  SANS -> 00:00:37.76   Testé avec 10 000 transactions