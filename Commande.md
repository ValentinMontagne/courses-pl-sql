# Commande

colima start
colima stop 
colima delete
colima ssh
docker ps pour lister les dockers présent

si aucun est présent il faut le créer avec cette commande docker
docker run -d -p 1521:1521 -e ORACLE_PASSWORD=oracle -e APP_USER=admin -e APP_USER_PASSWORD=password gvenzl/oracle-xe 