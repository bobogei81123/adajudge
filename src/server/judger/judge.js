import fs from 'fs-promise';
import config from '/config';
import errors from 'common-errors';
import {compile, run} from './shik';
import Result from '/model/result';
import logger from '/logger';
import path from 'path';
import _ from 'lodash';
import {promisify} from 'bluebird';
import temp from 'temp';
import Worker from './pool';

const DEFAULT_CHECKER = path.join(config.dirs.cfiles, 'default_checker.cpp');
const TESTLIB = path.join(config.dirs.cfiles, 'testlib.h');
const JAIL = path.join(__dirname, 'jail');

const resultMap = {
    'CE': 100000,
    'RE': 10000,
    'WA': 1000,
    'TLE': 100,
    'AC': 1,
};
const resultReducer = (pointReducer = (p1, p2) => Math.min(p1 || 0, p2 || 0)) => ((res, x) => {
    const resW = _.get(resultMap, res.result, 1e9),
        xW = _.get(resultMap, x.result, 1e9);
    const res_ = {};
    res_.result = resW > xW ? res.result : x.result;
    res_.runtime = Math.max(res.runtime, x.runtime);
    res_.points = pointReducer(res.points, x.points);
    return res_;
});

async function saveResult(obj, result, points=0) {
    obj.result = result;
    obj.points = points;
    return await obj.save();
}

async function copyToDir(file, dir, newName) {
    try {
        await fs.stat(file);
    } catch(e) {
        throw new errors.io.FileNotFoundError(file);
    }

    const newDir = path.join(dir, newName ? newName : path.basename(file));
    await fs.copy(file, newDir);
    return newDir;
}

async function mkdir777(dir) {
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o777);
}

const GPP = [
    'g++',
    '-std=c++14',
    '-static',
    '-O2',
];


export default class Judger {
    constructor(sub) {
        this.sub = sub;
        this.problem = sub.problem;
        this.problemDir = path.join(config.dirs.problems, `${sub.problem._id}`);
        this.testdata = this.problem.testdata;
        this.groups = this.testdata.groups;
        this.userCpp = path.join(config.dirs.submissions, `${this.sub._id}.cpp`);
        this.checkerCpp = this.problem.hasSpecialJudge ? 
            path.join(this.problemDir, 'checker.cpp') : DEFAULT_CHECKER;
        this.result = new Result({
            name: this.problem._id,
            maxPoints: this.testdata.points,
        });
    }
    async prepare() {
        this.sub._result = this.result._id;
        this.sub.save();
    }
    async prepareCpp() {
        this.rootDir = await promisify(temp.mkdir)({dir: JAIL});
        await fs.chmod(this.rootDir, 0o777);
        this.userDir = path.join(this.rootDir, 'user');
        await mkdir777(this.userDir);
        this.userCpp = await copyToDir(this.userCpp, this.userDir, 'user.cpp');
        this.checkerCpp = await copyToDir(this.checkerCpp, this.rootDir, 'checker.cpp');
        await copyToDir(TESTLIB, this.rootDir);
    }
    async compileUser() {
        const result = await compile(this.userDir, 'user.cpp', 'user', GPP);
        if (result.RE) {
            saveResult(this.result, 'CE');
            await copyToDir(
                path.join(this.userDir, 'compile.err'),
                config.dirs.submissions,
                `${this.sub._id}.compile.err`,
            );
            return false;
        }
        this.userExec = path.join(this.userDir, 'user');
        return true;
    }
    async compileChecker() {
        const result = await compile(this.rootDir, 'checker.cpp', 'checker', GPP);
        if (result.RE) {
            throw Error('Judge Error: Checker Compiled Error.');
        }
        this.checkerExec = path.join(this.rootDir, 'checker');
    }
    async prepareFiles() {
        for (let [gid, group] of this.groups.entries()) {
            const userGDir = path.join(this.userDir, `${gid}`);
            const checkerGDir = path.join(this.rootDir, `${gid}`);
            await mkdir777(userGDir);
            await mkdir777(checkerGDir);
            for (let [tid, test] of group.tests.entries()) {
                const userTDir = path.join(userGDir, `${tid}`);
                const checkerTDir = path.join(checkerGDir, `${tid}`);
                const tdBase = path.join(this.problemDir, 'testdata', test);
                const [inp, outp] = ['in', 'out'].map(x => `${tdBase}.${x}`); 
                // Copy input file
                await mkdir777(userTDir, 0o777);
                await copyToDir(inp, userTDir, 'prob.in');
                // Copy ans file
                await mkdir777(checkerTDir, 0o777);
                await copyToDir(outp, checkerTDir, 'prob.ans');
                // Copy user exec
                await copyToDir(this.userExec, userTDir);
            }
        }
    }

    generateTask(gid, groupResult, tid, testResult) {
        return async () => {
            await (async () => {
                const gidtid = [gid.toString(), tid.toString()];
                const userTDir = path.join(this.userDir, ...gidtid); 
                const userRes = await run(userTDir, 'user', 
                    'prob.in', 'prob.out', 'prob.err', 
                    this.problem.timeLimit);

                testResult.runtime = userRes.cpu_time_usage;
                if (userRes.RE) {
                    await saveResult(testResult, 'RE');
                    return;
                }
                if (userRes.TLE) {
                    testResult.runtime = this.problem.timeLimit;
                    await saveResult(testResult, 'TLE');
                    return;
                }
                const files = [
                    path.join('user', ...gidtid, 'prob.in'),
                    path.join('user', ...gidtid, 'prob.out'),
                    path.join(...gidtid, 'prob.ans'),
                ];
                const checkerRes = await run(this.rootDir, 'checker', 
                    null, path.join(...gidtid, 'checker.out'), path.join(...gidtid, 'checker.err'),
                    30, 1<<30, files);

                if (checkerRes.TLE) {
                    throw new Error('Judge Error: Checker TLE.');
                }
                if (checkerRes.RE) {
                    await saveResult(testResult, 'WA');
                } else {
                    await saveResult(testResult, 'AC', testResult.maxPoints);
                }
            })();
            this.remains[gid] --;
            if (!this.remains[gid]) {
                const _groupResult = _.reduce(
                    this.testResults[gid],
                    resultReducer(),
                    {result: 'AC', runtime: 0, points: groupResult.maxPoints}
                );
                _.assignIn(groupResult, _groupResult);
                await groupResult.save();
            }
        };
    }

    async loadTasks() {
        this.tasks = [];
        this.remains = [];
        this.testResults = [];
        this.groupResults = [];
        for (let [gid, group] of this.groups.entries()) {
            const groupResult = new Result({
                name: `${this.problem._id}.${gid}`,
                maxPoints: group.points,
            });

            const tests = [];
            for (let [tid, test] of group.tests.entries()) {
                const testResult = new Result({
                    name: `${this.problem._id}.${gid}.${tid}_${test}`,
                    maxPoints: group.points,
                });
                await testResult.save(); 
                groupResult.subresults.push(testResult._id);
                tests.push(testResult);

                this.tasks.push(this.generateTask(
                    gid, groupResult, tid, testResult
                ));
            }

            await groupResult.save();
            this.result.subresults.push(groupResult._id);
            this.testResults.push(tests);
            this.groupResults.push(groupResult);
            this.remains.push(group.tests.length);
        }
        await this.result.save();
    }
    async runAndCheck() {
        const workers = [];
        for (let i=0; i<config.maxWorkers; i++) {
            workers.push(new Worker());
        }

        let error = null;
        for (let [taskID, task] of this.tasks.entries()) {
            const {worker, ret} = await Promise.race(workers.map(x => x.finish()));
            worker.run(task, (err) => {
                if (err) {
                    logger.error(`Judge error @ ${taskID}`, err);
                    error = err;
                }
            });
            if (error) break;
        }
        await Promise.all(workers.map(x => x.finish()));
        if (error) {
            throw Error('Judge error when running.');
        }

        const reducedResult = _.reduce(
            this.groupResults,
            resultReducer((x, y) => x+y),
            {result: 'AC', runtime: 0, points: 0}
        );
        _.assignIn(this.result, reducedResult);
        await this.result.save();
    }
    async cleanUp() {
        if (this.rootDir) await fs.remove(this.rootDir);
    }
    async go() {
        try {
            logger.info('Preparing...');
            await this.prepare();

            logger.info('Preparing Cpp...');
            await this.prepareCpp();

            logger.info('Compiling User Cpp...');
            const compileFlag = await this.compileUser();
            if (!compileFlag) {
                return this.result;
            }

            logger.info('Compiling Checker Cpp...');
            await this.compileChecker();

            logger.info('Preparing Files...');
            await this.prepareFiles();

            logger.info('Loading Tasks...');
            await this.loadTasks();

            logger.info('Finally, Run and Check...');
            await this.runAndCheck();

            return this.result;
        } catch(e) {
            throw(e);
        }finally {
            await this.cleanUp();
        }
    }
}
