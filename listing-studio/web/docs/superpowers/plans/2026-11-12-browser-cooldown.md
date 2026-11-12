# Amazon 人机验证后等待 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 遇 Amazon 人机验证，保存资料、关闭调研页，整个队列等待30分钟后自动继续；重复验证重新等待。

**Architecture:** TaskRunner 持久化全局等待记录并使用单个定时器；沿用串行队列、现有结果、资源检查和取消逻辑。Amazon验证用明确的平台/阻碍标记识别，兼容旧检查点的明确Amazon验证说明；Sif登录保留人工处理。

**Tech Stack:** Node.js builtins, node:test, 现有CDP页面回收。

**Spec:** 用户2026-11-12 19:17明确要求关闭标签页并等待半小时后继续。

## Global Constraints

- 等待30分钟从标签页成功关闭起计算，期间队列恢复操作不能提前启动。
- 不自动提交人机验证，不换代理、清Cookie或重启浏览器规避限制。
- 保留已核实资料与换词意图，自动继续受阻任务并保持后续顺序。
- 手动停止或删除的任务不自动复活；全局等待仍保护剩余队列。
- 重启恢复原截止时间；损坏的等待记录使队列安全暂停。

## Review Focus

- 取消、删除、手动恢复与计时到期并发不能重复执行或复活取消任务。
- Sif登录、普通Amazon登录表单和页脚Sign in不应进入自动重试。
- 关闭页面失败时不能启动任务或提前宣称已关闭。
- 服务重启、截止时间已过和重复验证码各自正确处理。
- 关键词专用任务保留原词表和keywordJob，不能转成完整任务。

### Task 1: 持久化等待及队列集成

**Files:** Create lib/browser-cooldown.mjs, test/browser-cooldown.test.mjs; Modify lib/runner.mjs, server.mjs.

- [x] 先写用可控时钟证明上述时序和取消边界的失败测试。
- [x] 原子保存 browser-cooldown.json，等待期间关闭页面但保留Cookie，单定时器到期重新驱动现有队列。
- [x] full和keywords_only统一识别Amazon验证；继续采用现有资源/登录保护；服务关闭清定时器。
- [x] 运行定向测试并检查全部回归。

### Task 2: 提示词、界面与上线

**Files:** Modify lib/browser-policy.mjs, public/app.js, README.md.

- [x] 明确Amazon验证保存检查点后由工作台关页等待；Sif登录保持人工处理。
- [x] 等待条显示恢复时间和剩余分钟，不提供提前恢复按钮。
- [x] 复核、部署并保存真实页面回收证据；当前已停止任务不重启，剩余队列按等待记录恢复。
- [x] GitHub同步，仅提交源码、测试和说明。
