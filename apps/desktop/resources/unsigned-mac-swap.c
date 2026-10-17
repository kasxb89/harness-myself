/* Atomic exchange of two existing, same-volume app directories; no elevation or deletion. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static int matches(const struct stat *info, const char *identity) {
  unsigned long long device, inode;
  char extra;
  return sscanf(identity, "%llu:%llu%c", &device, &inode, &extra) == 2
    && (unsigned long long)info->st_dev == device && (unsigned long long)info->st_ino == inode;
}

int main(int argc, char **argv) {
  struct stat left, right;
  if (argc != 5 || argv[1][0] != '/' || argv[2][0] != '/') {
    fputs("unsigned Mac swap: expected two absolute directories and identities\n", stderr);
    return 2;
  }
  if (lstat(argv[1], &left) || lstat(argv[2], &right) || !S_ISDIR(left.st_mode) || !S_ISDIR(right.st_mode)
      || left.st_dev != right.st_dev || !matches(&left, argv[3]) || !matches(&right, argv[4])) {
    fputs("unsigned Mac swap: application identity changed or volumes differ\n", stderr);
    return 3;
  }
  if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP)) {
    perror("unsigned Mac swap: atomic exchange failed");
    return 1;
  }
  return 0;
}
