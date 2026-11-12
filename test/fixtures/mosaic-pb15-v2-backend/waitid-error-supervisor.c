#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
static int fail_once=1;
static int transient_waitid(idtype_t type,id_t id,siginfo_t *info,int flags){if(fail_once){fail_once=0;errno=EINVAL;return -1;}return waitid(type,id,info,flags);}
#define waitid transient_waitid
#include "../../../src/project/check-backends/native-supervisor.c"
