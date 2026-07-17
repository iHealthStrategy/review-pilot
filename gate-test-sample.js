// ⚠️ GATE TEST ONLY —— 故意引入的 major 级安全问题(命令注入),
// 仅用于验证 review-pilot 的 block+major 评审门禁会拦截有问题的改动。
// 这个分支不应被合并;测试完请关闭 PR、删除分支、删除本文件。
"use strict";

const { exec } = require("node:child_process");

// major(命令注入):用户提供的 name 未经任何校验/转义,直接拼进 shell 命令。
// 攻击者可通过形如 `x; rm -rf ~` 的输入执行任意命令 —— 典型的可利用漏洞,
// 评审内核应判定为 major/critical,从而在 block+major 策略下被门禁拦下。
function listDir(userProvidedName) {
  exec("ls -la " + userProvidedName, (err, stdout) => {
    if (err) throw err;
    console.log(stdout);
  });
}

module.exports = { listDir };
