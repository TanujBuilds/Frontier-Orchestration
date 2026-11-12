#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <signal.h>
#include <string.h>
#include <fcntl.h>
static void late(const char *p){signal(SIGTERM,SIG_IGN);close(1);close(2);usleep(700000);int f=open(p,O_WRONLY|O_CREAT|O_APPEND,0600);if(f>=0){write(f,"late",4);close(f);}_exit(0);}
int main(int n,char **v){if(n<3)return 2;if(!strcmp(v[1],"normal")){int ready[2];if(pipe(ready))return 3;if(!fork()){close(ready[0]);signal(SIGTERM,SIG_IGN);write(ready[1],"R",1);close(ready[1]);late(v[2]);}close(ready[1]);char r=0;if(read(ready[0],&r,1)!=1)return 3;close(ready[0]);puts("parent-zero");return 0;}if(!strcmp(v[1],"timeout")){signal(SIGTERM,SIG_IGN);puts("timeout-ready");fflush(stdout);for(;;)pause();}if(!strcmp(v[1],"output")){for(int i=0;i<100000;i++)puts("012345678901234567890123456789");return 0;}if(!strcmp(v[1],"flood")){for(int i=0;i<3;i++)if(!fork()){for(int j=0;j<20;j++){if(!fork())late(v[2]);usleep(1000);}late(v[2]);}late(v[2]);}return 2;}
