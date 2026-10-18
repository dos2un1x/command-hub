# 内容来源与授权边界

本文件记录 command-hub 中第三方内容的来源、固定版本、完整页面清单，以及本站自有内容的边界。**本文件不是许可证**；许可证正文以 [LICENSE](LICENSE) 为准。

- 机器可读清单：[provenance.json](provenance.json)（重写进度以其中的 `rewritten_pages` 为准）
- 执行计划：[UPSTREAM-REWRITE-PLAN.md](UPSTREAM-REWRITE-PLAN.md)
- 当前进度：仍属上游 621 页，已重写 0 页（每批完成后更新）

## 上游来源

- 仓库：<https://github.com/jaywcjlove/linux-command>
- 固定 commit：`cd17682d612e6fdfaff29261c11ffbc3f951f41d`（2026-09-06）
- 许可证：MIT License，Copyright © 2019 小弟调调™
- MIT 全文：见 [LICENSE](LICENSE) 的“第三方内容”段

截至 2026-10-18 对比，`command/linux/` 下 618 个页面来自上游，其中 480 个与上述 commit 逐字节相同，138 个经过本站修改；`command/k8s/` 下另有 3 个页面来自上游。**修改过的页面仍然是上游内容的衍生作品，不能因为改过就移出本清单。**

## 上游内容清单（621 页）

### command/linux/（618 页）

```text
7z
ab
accept
ack
ag
alias
ansible
apachectl
apk
apropos
apt-get
apt-key
apt-sortpkgs
aptitude
ar
arch
arj
arp
arpd
arping
arptables
arpwatch
as
at
atop
atq
atrm
awk
axel
badblocks
base64
basename
batch
bc
beep
bg
bind
blkid
blockdev
break
builtin
bunzip2
bye
bzcat
bzcmp
bzdiff
bzgrep
bzip2
bzip2recover
bzless
bzmore
cal
cancel
cat
cd
cdrecord
chage
chattr
chcon
chfn
chgrp
chkconfig
chmod
chown
chpasswd
chroot
chsh
cksum
clear
clock
clockdiff
cmp
col
colrm
column
comm
command
compress
consoletype
continue
convertquota
cp
cpio
createrepo
crontab
csplit
cu
cupsdisable
cupsenable
curl
cut
date
dc
dd
declare
depmod
df
dhclient
dhcpd
dhcrelay
diff
diff3
diffstat
dig
dircolors
dirname
dirs
disown
dmesg
dmidecode
dnf
dnsdomainname
domainname
dos2unix
dpkg
dpkg-deb
dpkg-divert
dpkg-preconfigure
dpkg-query
dpkg-reconfigure
dpkg-split
dpkg-statoverride
dpkg-trigger
dris
dstat
du
dump
e2fsck
e2label
echo
ed
edquota
egrep
eject
elinks
elm
emacs
enable
env
ethtool
ex
exec
exit
expand
export
exportfs
expr
false
fc
fdisk
fg
fgrep
figlet
file
find
findfs
finger
firewall-cmd
firewalld
fishshell
fmt
fold
fping
free
fsck
ftp
ftpcount
ftpshut
ftptop
ftpwho
fuser
gcc
gcov
gdb
get_module
getcap
getenforce
getent
getfacl
getsebool
git
gpasswd
gpg
gpm
grep
groupadd
groupdel
groupmems
groupmod
groups
grpck
grpconv
grpunconv
grub
grub2-mkconfig
grub2-set-default
gunzip
gzexe
gzip
halt
hcitool
hdparm
head
help
hexdump
history
host
hostid
hostname
hostnamectl
hping3
htdigest
htop
htpasswd
hwclock
iconv
id
ifcfg
ifconfig
ifdown
ifstat
iftop
ifup
indent
info
init
inotifywait
insmod
install
iostat
iotop
ip
ip6tables
ip6tables-restore
ip6tables-save
ipcalc
ipcrm
ipcs
iperf
iptables
iptables-restore
iptables-save
iptraf
iptstate
iscsiadm
ispell
jed
jobs
joe
join
journalctl
jq
jwhois
kernelversion
kexec
kill
killall
l2ping
last
lastb
lastlog
ld
ldconfig
ldd
less
let
lftp
lftpget
lha
lilo
ln
lnstat
local
locate
logger
login
logname
logout
logrotate
logsave
logwatch
look
losetup
lp
lpadmin
lpc
lpq
lpr
lprm
lpstat
ls
lsattr
lsb_release
lsblk
lscpu
lsmod
lsof
lspci
lsusb
ltrace
lvcreate
lvdisplay
lvextend
lvreduce
lvremove
lvresize
lvscan
lynx
mail
mailq
mailstat
make
man
mapfile
md5sum
mesg
mii-tool
mkbootdisk
mkcert
mkdir
mke2fs
mkfs
mkinitrd
mkisofs
mknod
mkswap
mktemp
modetest
modinfo
modprobe
more
mount
mpstat
mtools
mtr
mv
mysql
mysqladmin
mysqldump
mysqlimport
mysqlshow
named-checkzone
nano
nc
ncdu
ncftp
neofetch
nethogs
netstat
newusers
nfsstat
ngrep
nice
nisdomainname
nl
nm
nmap
nmcli
nmtui
nohup
nologin
nproc
nslookup
nstat
ntpdate
ntsysv
objdump
od
openssl
pacman
parted
partprobe
passwd
paste
patch
pathchk
perl
pfctl
pgrep
php
pico
pidof
pidstat
pigz
ping
ping6
pip
pkexec
pkill
pmap
popd
poweroff
ppp-off
pr
printf
protoize
prtstat
ps
pssh
pstack
pstree
pushd
pv
pvchange
pvck
pvcreate
pvdisplay
pvremove
pvs
pvscan
pwck
pwconv
pwd
pwdx
pwunconv
quota
quotacheck
quotaoff
quotaon
rcconf
rcp
read
readelf
readonly
realpath
reboot
reject
rename
renice
reposync
repquota
resize
restore
restorecon
return
rev
rexec
rlogin
rm
rmdir
rmmod
route
rpm
rpm2cpio
rpmbuild
rpmdb
rpmquery
rpmsign
rpmverify
rsh
rsync
runlevel
sar
scp
screen
script
scriptreplay
sed
seinfo
semanage
sendmail
seq
service
sesearch
set
setfacl
setpci
setsebool
setsid
sftp
sftp-server
sh
sha256sum
shift
shopt
showmount
shuf
shutdown
skill
slabtop
sleep
slocate
smartmontools
smbclient
smbpasswd
sort
sosreport
source
speedtest-cli
spell
split
squid
squidclient
ss
ssh
ssh-add
ssh-agent
ssh-copy-id
ssh-keygen
ssh-keyscan
sshd
sshpass
startx
stat
strace
strings
stty
su
sudo
sum
supervisord
suspend
swapoff
swapon
sync
sysctl
syslog
systemctl
systool
tac
tail
tailf
talk
tar
tcpdump
tcpreplay
tee
telinit
telnet
tempfile
test
tftp
time
timedatectl
times
tload
tmux
top
touch
tput
tr
tracepath
traceroute
trap
tree
true
tty
type
ufw
ulimit
umask
umount
unalias
uname
unarj
uncompress
unexpand
uniq
unlink
unprotoize
unrar
unset
unzip
updatedb
uptime
useradd
userdel
usermod
usernetctl
users
uucico
uupick
uuto
vdfuse
vgchange
vgconvert
vgcreate
vgdisplay
vgextend
vgreduce
vgremove
vgrename
vgscan
vi
vmstat
volname
w
wait
wall
watch
wc
wget
whatis
whereis
which
who
whoami
write
xargs
xauth
xclip
xhost
xinit
xlsatoms
xlsclients
xlsfonts
xrandr
xset
xz
yes
ypdomainname
yum
zcat
zfore
zip
zipinfo
zipsplit
znew
```

### command/k8s/（3 页）

```text
docker
helm
kubectl
```

## 自有内容

除上述 621 页外，仓库内其余内容均为本站作者所写，适用 [LICENSE](LICENSE) 顶部的 MIT 许可，包括：

- `command/linux/` 下不在上述清单中的 244 个页面
- Kubernetes 分支的其余 271 个页面
- DevOps 97、排障 134、指南 120、中间件 71、教程 77、AI 与 MLOps 84 个页面
- 构建管线（`scripts/`）、模板（`template/`）、样式与脚本（`assets/`）、配置（`branches.json`）与文档

## 维护规则

1. 新增页面不改变本清单的归属；新增页面默认属于自有内容。
2. 修改上游页面仍是衍生作品，不能从清单移除。
3. 只有从 man page、`--help`、官方文档独立重写，且通过相似度检查，才能把 slug 从上游清单移入自有内容。
4. 每次迁移后同步更新本文件、`LICENSE` 中的数量，并运行 `npm run verify`。
5. 在本清单清空之前，不得删除 `LICENSE` 中的上游 MIT 段。
6. 本文件必须保留在仓库根目录，不要放进被 `.gitignore` 忽略的 `docs/`。

## 完全自有化计划（第 3 步）

目标：保持 URL、标题、描述和站内链接不变，把 621 个上游页面逐页替换为独立撰写的内容，最终从 `LICENSE` 移除第三方 MIT 段。不采用“删除 618 页”的方案，因为 Linux 会从 862 页降到 244 页，学习路径、速查表和交叉链接会大量断链。

### 阶段 0：固定基线（已完成）

- 固定上游 commit 与 621 页清单。
- 明确“修改不等于重写”：480 个逐字节相同页、138 个修改页都仍在清单内。

### 阶段 1：建立验收工具

- 增加 `scripts/provenance.mjs`：读取本清单，检查每个 slug 是否存在、是否仍标记为上游内容。
- 增加相似度检查：与固定上游 commit 对比，报告中文字符连续相同片段和英文单词连续相同片段；命令语法、选项名、参数名不计入。
- 验收标准：除命令语法与专有名词外，不出现与上游连续相同的长句；页面结构、描述、自测和站内链接通过 `npm run verify`。
- 每批产出一份记录：slug、参考的官方文档 URL、重写日期、审核结论。

### 阶段 2：高频 50 页

优先重写搜索量和操作风险最高的页面，例如 ls、grep、find、awk、sed、tar、chmod、chown、ps、top、df、du、ssh、curl、systemctl、journalctl、git、cp、mv、rm、mkdir、ln、mount、ip、ss、dig、crontab、dmesg、lsof、strace、vim、nano、kill、pkill、free、vmstat、iostat、netstat、route、iptables、firewall-cmd、useradd、usermod、passwd、su、sudo、rsync、scp、screen、tmux。

每批 15–20 页，建议 3 批完成。完成后从上游清单移除这 50 个 slug，更新数量，保留其余页面的 MIT 声明。

### 阶段 3：中频 150 页

按文件与文本、进程与资源、网络、磁盘与文件系统、开发与构建、权限与安全、数据库客户端分组，每批 15–25 页，约 8 批。优先处理仍被学习路径、速查表和排障页引用的页面。

### 阶段 4：长尾 418 页与 3 个 K8s 页

剩余长尾页按分类批量重写，每批 20–25 页，约 18–20 批。对长期无搜索价值、内容重复度高的页面，可评估合并或下线，但必须先处理站内链接。`docker`、`helm`、`kubectl` 三页优先于长尾页重写，因为它们被大量教程引用。

### 阶段 5：收尾与许可证切换

- 621 页全部通过相似度检查和人工复核。
- 从 `LICENSE` 移除第三方内容段，只保留本站自有内容的许可。
- 更新 README、CONTRIBUTING 和本文件，保留历史记录。
- 评估是否重写 Git 历史：当前树的替换不会删除旧 commit 中的上游内容；如果要求仓库历史也不含上游内容，需要像之前清理隐私那样重写历史或新建仓库。旧版本已经按 MIT 授权，接收者的权利不会因新版本换 license 而消失。

### 工作量与风险

- 总量约 30–40 个批次；高频页每批更慢，长尾页可以更快。
- 最大风险是“改写后仍是衍生作品”。不要边看上游边改词；先读官方文档写新稿，再做相似度检查。
- 第二风险是历史提交仍含上游内容；只改当前树不等于仓库历史干净。
- 第三风险是重写导致内容质量和内链回退；每批必须跑 `npm run verify`，并抽查页面。
