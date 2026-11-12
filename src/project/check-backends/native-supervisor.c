/* Protocol 1: only this trusted outer process owns/reaps the sandbox leader. */
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <spawn.h>
extern char **environ;

static volatile sig_atomic_t interrupted=0;
static void stop(int sig){(void)sig;interrupted=1;}
static double ms(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec*1000.0+t.tv_nsec/1000000.0;}
static int observed(pid_t p){siginfo_t s;int rc;do{memset(&s,0,sizeof(s));rc=waitid(P_PID,p,&s,WEXITED|WNOWAIT|WNOHANG);}while(rc<0&&errno==EINTR);if(rc<0)return -errno;return s.si_pid==p;}
static int group_signal(pid_t p,int sig){if(killpg(p,sig)==0)return 0;return errno;}
static int hex(const char *s,size_t length){if(strlen(s)!=length)return 0;for(size_t i=0;i<length;i++)if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return 0;return 1;}
static int request_id(const char *s){if(strlen(s)!=36)return 0;for(int i=0;i<36;i++)if(i==8||i==13||i==18||i==23){if(s[i]!='-')return 0;}else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return 0;return 1;}
static int number(const char *s,int low,int high){char *end=NULL;long n=strtol(s,&end,10);return end&&!*end&&n>=low&&n<=high?(int)n:-1;}
static int write_all(int fd,const char *s,size_t n){while(n){ssize_t k=write(fd,s,n);if(k<0&&errno==EINTR)continue;if(k<=0)return -1;s+=k;n-=(size_t)k;}return 0;}
static void nonblock(int fd){int flags=fcntl(fd,F_GETFL);if(flags>=0)fcntl(fd,F_SETFL,flags|O_NONBLOCK);}
static int save_receipt(const char *file,const char *text){
 int f=open(file,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(f<0)return -1;
 int ok=write_all(f,text,strlen(text))==0&&fsync(f)==0;if(close(f)<0)ok=0;
 char dir[PATH_MAX];size_t n=strlen(file);if(n>=sizeof(dir))return -1;memcpy(dir,file,n+1);char *slash=strrchr(dir,'/');if(!slash)return -1;if(slash==dir)slash[1]=0;else *slash=0;
 int d=open(dir,O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(d<0)return -1;if(fsync(d)<0)ok=0;close(d);return ok?0:-1;
}
static void event(const char *type,const char *id,const char *binding,pid_t leader){char s[512];int n=snprintf(s,sizeof(s),"{\"schema\":1,\"type\":\"%s\",\"requestId\":\"%s\",\"bindingHash\":\"%s\",\"helperPid\":%d,\"leaderPid\":%d}\n",type,id,binding,getpid(),leader);if(n>0&&(size_t)n<sizeof(s))write_all(3,s,(size_t)n);}
static int pump(int from,int to,size_t *total,size_t cap){
 char buf[4096];for(int turn=0;turn<16;turn++){ssize_t n=read(from,buf,sizeof(buf));if(n<0&&(errno==EAGAIN||errno==EWOULDBLOCK))return 0;if(n<0&&errno==EINTR)continue;if(n<=0)return 0;
 size_t want=(size_t)n;if(want>cap-*total)want=cap-*total;if(want&&write_all(to,buf,want)<0){*total=cap;return 1;}*total+=want;if(want<(size_t)n)return 1;}return 0;
}
static int probe(const char *node){
 if(node[0]!='/')return 2;
 pid_t pid=getpid(),before=getpgrp(),child=-1;errno=0;int sid=setsid(),sidError=errno;errno=0;int pg=setpgid(0,0),pgError=errno;
 char *args[]={(char*)node,"-e","process.exit(0)",NULL};posix_spawnattr_t attr;if(posix_spawnattr_init(&attr))return 2;
 int ordinary=posix_spawn(&child,node,NULL,&attr,args,environ);if(!ordinary)waitpid(child,NULL,0);
 if(posix_spawnattr_setflags(&attr,POSIX_SPAWN_SETSID)){posix_spawnattr_destroy(&attr);return 2;}
 int detached=posix_spawn(&child,node,NULL,&attr,args,environ);if(!detached)waitpid(child,NULL,0);posix_spawnattr_destroy(&attr);
 printf("{\"schema\":1,\"pid\":%d,\"beforePgid\":%d,\"pgid\":%d,\"sid\":%d,\"setsid\":{\"rc\":%d,\"errno\":%d},\"setpgid\":{\"rc\":%d,\"errno\":%d},\"spawn\":{\"rc\":%d},\"spawnDetached\":{\"rc\":%d}}\n",pid,before,getpgrp(),getsid(0),sid,sidError,pg,pgError,ordinary,detached);return 0;
}
int main(int argc,char **argv){
 if(argc==3&&!strcmp(argv[1],"--probe"))return probe(argv[2]);
 /* requestId bindingHash privateReceipt timeoutMs outputBytes cwd profile -- literal argv */
 if(argc<10||!request_id(argv[1])||!hex(argv[2],64)||argv[3][0]!='/'||strlen(argv[3])>=PATH_MAX||argv[6][0]!='/'||argv[7][0]!='/'||strcmp(argv[8],"--"))return 2;
 int timeout=number(argv[4],1,600000),cap=number(argv[5],1,1048576);if(timeout<0||cap<0||fcntl(3,F_GETFD)<0||fcntl(4,F_GETFD)<0)return 2;
 signal(SIGCHLD,SIG_DFL);signal(SIGPIPE,SIG_IGN);signal(SIGTERM,stop);signal(SIGINT,stop);fcntl(3,F_SETFD,FD_CLOEXEC);fcntl(4,F_SETFD,FD_CLOEXEC);
 for(int fd=5,maximum=getdtablesize();fd<maximum;fd++)close(fd);
 int out[2],err[2],gate[2],ready[2];if(pipe(out)||pipe(err)||pipe(gate)||pipe(ready))return 2;
 for(int fd=5;fd<=ready[1];fd++)fcntl(fd,F_SETFD,FD_CLOEXEC);
 char **cmd=calloc((size_t)argc+1,sizeof(char*));if(!cmd)return 2;cmd[0]="/usr/bin/sandbox-exec";cmd[1]="-f";cmd[2]=argv[7];for(int i=9;i<argc;i++)cmd[i-6]=argv[i];
 pid_t leader=fork();if(leader<0)return 2;
 if(!leader){
  close(3);close(4);close(out[0]);close(err[0]);close(gate[1]);close(ready[0]);
  if(setsid()<0){write_all(ready[1],"E",1);_exit(125);}if(chdir(argv[6])<0){write_all(ready[1],"E",1);_exit(125);}
  dup2(out[1],1);dup2(err[1],2);close(out[1]);close(err[1]);write_all(ready[1],"R",1);close(ready[1]);
  char go=0;ssize_t n;do{n=read(gate[0],&go,1);}while(n<0&&errno==EINTR);close(gate[0]);if(n!=1||go!='G')_exit(124);
  execv(cmd[0],cmd);_exit(126);
 }
 free(cmd);close(out[1]);close(err[1]);close(gate[0]);close(ready[1]);
 struct pollfd r={.fd=ready[0],.events=POLLIN};char acknowledgement=0;int startupFailed=poll(&r,1,2000)<=0||read(ready[0],&acknowledgement,1)!=1||acknowledgement!='R';close(ready[0]);
 if(startupFailed){close(gate[1]);gate[1]=-1;kill(leader,SIGKILL);}
 nonblock(out[0]);nonblock(err[0]);nonblock(4);nonblock(1);nonblock(2);event("prepared",argv[1],argv[2],leader);
 double started=ms();const char *reason=startupFailed?"startup-cancel":NULL;char control[32];size_t controlUsed=0,total=0;int launched=0;
 while(!reason){
  struct pollfd fds[3]={{.fd=4,.events=POLLIN},{.fd=out[0],.events=POLLIN},{.fd=err[0],.events=POLLIN}};poll(fds,3,5);
  if(interrupted)reason=launched?"cancel":"startup-cancel";
  if(!reason&&(fds[0].revents&(POLLIN|POLLHUP|POLLERR))){char b[32];ssize_t n=read(4,b,sizeof(b));if(n==0)reason="control-eof";else if(n>0){for(ssize_t i=0;i<n&&!reason;i++){if(controlUsed>=sizeof(control)-1){reason="cancel";break;}control[controlUsed++]=b[i];if(b[i]=='\n'){control[controlUsed]=0;if(!strcmp(control,"go\n")&&!launched){write_all(gate[1],"G",1);close(gate[1]);gate[1]=-1;launched=1;}else reason=launched?"cancel":"startup-cancel";controlUsed=0;}}}else if(errno!=EAGAIN&&errno!=EINTR)reason="control-eof";}
  if(pump(out[0],1,&total,(size_t)cap)||pump(err[0],2,&total,(size_t)cap))reason="output-limit";
  if(!reason&&ms()-started>=timeout)reason="timeout";
  int ex=observed(leader);if(ex<0){event("uncertain",argv[1],argv[2],leader);if(ex==-ECHILD){for(;;)poll(NULL,0,1000);}reason="cancel";}if(!reason&&ex==1)reason="exit";
 }
 if(gate[1]>=0)close(gate[1]);
 /* PID is still reserved. TERM grace, then repeated KILL until candidate drain. */
 group_signal(leader,SIGTERM);double cleaning=ms();int candidate=0,notified=0;
 for(;;){
  if(pump(out[0],1,&total,(size_t)cap)||pump(err[0],2,&total,(size_t)cap))reason="output-limit";
  int ex=observed(leader);if(ex==-ECHILD){event("uncertain",argv[1],argv[2],leader);for(;;)poll(NULL,0,1000);}
  int e=group_signal(leader,ms()-cleaning<50?0:SIGKILL);
  if(ms()-cleaning>=50&&ex==1&&(e==EPERM||e==ESRCH)){if(++candidate>=3)break;}else candidate=0;
  /* Keep the reservation and cleanup alive if drain cannot be established. */
  if(ms()-cleaning>2500&&!notified){event("uncertain",argv[1],argv[2],leader);notified=1;}
  usleep(notified?100000:1000);
 }
 int status=0;pid_t reaped;do{reaped=waitpid(leader,&status,0);}while(reaped<0&&errno==EINTR);if(reaped!=leader){event("uncertain",argv[1],argv[2],leader);return 3;}
 /* Never send any nonzero PID/group signal after this single reap. */
 double released=ms();int empty=0;while(ms()-released<2500){if(group_signal(leader,0)==ESRCH){empty=1;break;}usleep(1000);}
 pump(out[0],1,&total,(size_t)cap);pump(err[0],2,&total,(size_t)cap);close(out[0]);close(err[0]);
 if(!empty){event("uncertain",argv[1],argv[2],leader);return 3;}
 char receipt[1024];int code=WIFEXITED(status)?WEXITSTATUS(status):-1,sig=WIFSIGNALED(status)?WTERMSIG(status):0;
 int n=snprintf(receipt,sizeof(receipt),"{\"schema\":1,\"type\":\"complete\",\"requestId\":\"%s\",\"bindingHash\":\"%s\",\"helperPid\":%d,\"leaderPid\":%d,\"reason\":\"%s\",\"code\":%d,\"termSignal\":%d,\"groupESRCH\":true,\"leaderReaped\":true,\"nonzeroSignalsAfterReap\":0}\n",argv[1],argv[2],getpid(),leader,reason,code,sig);
 if(n<=0||(size_t)n>=sizeof(receipt)||save_receipt(argv[3],receipt)<0){event("uncertain",argv[1],argv[2],leader);return 3;}
 write_all(3,receipt,(size_t)n);return 0;
}
