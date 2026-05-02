#define _GNU_SOURCE
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int append_node_option(const char *option) {
    const char *current = getenv("NODE_OPTIONS");
    if (current != NULL && strstr(current, option) != NULL) {
        return 0;
    }

    size_t current_len = current == NULL ? 0 : strlen(current);
    size_t option_len = strlen(option);
    size_t total_len = current_len + (current_len > 0 ? 1 : 0) + option_len + 1;
    char *updated = malloc(total_len);
    if (updated == NULL) {
        fprintf(stderr, "failed to allocate NODE_OPTIONS\n");
        return 1;
    }

    if (current_len > 0) {
        snprintf(updated, total_len, "%s %s", current, option);
    } else {
        snprintf(updated, total_len, "%s", option);
    }

    int rc = setenv("NODE_OPTIONS", updated, 1);
    free(updated);
    if (rc != 0) {
        fprintf(stderr, "failed to set NODE_OPTIONS: %s\n", strerror(errno));
        return 1;
    }
    return 0;
}

int main(int argc, char **argv) {
    char exe_path[PATH_MAX];
    ssize_t exe_len = readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
    if (exe_len < 0) {
        perror("readlink /proc/self/exe");
        return 127;
    }
    exe_path[exe_len] = '\0';

    char dir_buf[PATH_MAX];
    if (snprintf(dir_buf, sizeof(dir_buf), "%s", exe_path) >= (int)sizeof(dir_buf)) {
        fprintf(stderr, "node_repl path is too long\n");
        return 127;
    }

    char script_path[PATH_MAX];
    char *dir = dirname(dir_buf);
    if (snprintf(script_path, sizeof(script_path), "%s/node_repl.mjs", dir) >= (int)sizeof(script_path)) {
        fprintf(stderr, "node_repl.mjs path is too long\n");
        return 127;
    }

    const char *node = getenv("NODE_REPL_NODE_PATH");
    if (node == NULL || node[0] == '\0') {
        node = getenv("CODEX_BROWSER_USE_NODE_PATH");
    }
    if (node == NULL || node[0] == '\0') {
        node = "node";
    }

    if (append_node_option("--experimental-vm-modules") != 0) {
        return 127;
    }

    char **child_argv = calloc((size_t)argc + 2, sizeof(char *));
    if (child_argv == NULL) {
        fprintf(stderr, "failed to allocate child argv\n");
        return 127;
    }

    child_argv[0] = (char *)node;
    child_argv[1] = script_path;
    for (int i = 1; i < argc; i++) {
        child_argv[i + 1] = argv[i];
    }
    child_argv[argc + 1] = NULL;

    if (strchr(node, '/') != NULL) {
        execv(node, child_argv);
    } else {
        execvp(node, child_argv);
    }

    fprintf(stderr, "failed to exec %s: %s\n", node, strerror(errno));
    return 127;
}
