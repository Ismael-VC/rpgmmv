// Copyright 2015 Hajime Hoshi
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/*:
 * @plugindesc CTB (Count Time Battle) like FF10.
 * @author Hajime Hoshi
 *
 * @param Formula 
 * @desc The formula to calculate the multiplier of the waiting point for a turn.
 * @default a.agi / (battlers.reduce(function(p, b) { return p + b.agi; }, 0) / battlers.length)
 *
 * @help This plugin offers Count Time Battle system.
 * A battler has a 'waiting point' and this increases for each frame.
 * A battler becames actionable when its waiting point reaches maximum (65536).
 * Note that this is not 'ATB' but 'CTB' because time stops for any actions.
 * I used EllyeSimpleATB.js as reference (http://pastebin.com/fhGC2Sn7).
 */

(function() {
    var parameters = PluginManager.parameters('HajimeHoshi_CTB');
    // TODO: Consider traits (see attackSpped()).
    var formula = String(parameters['Formula'] || 'a.agi / (battlers.reduce(function(p, b) { return p + b.agi; }, 0) / battlers.length)');

    //
    // UI
    //

    var MAX_WP = 65536;
    var AVERAGE_TIME = 60;

    // TODO: This hides actors' states accidentally.
    Window_BattleStatus.prototype.gaugeAreaWidth = function() {
        return 400;
    };

    Window_BattleStatus.prototype.drawGaugeAreaWithTp = function(rect, actor) {
        this.drawActorHp(actor, rect.x + 0, rect.y, 97);
        this.drawActorMp(actor, rect.x + 112, rect.y, 86);
        this.drawActorTp(actor, rect.x + 213, rect.y, 86);
        this.drawActorWp(actor, rect.x + 314, rect.y, 86);
    };

    Window_BattleStatus.prototype.drawGaugeAreaWithoutTp = function(rect, actor) {
        this.drawActorHp(actor, rect.x + 0, rect.y, 130);
        this.drawActorMp(actor, rect.x + 145,  rect.y, 120);
        this.drawActorWp(actor, rect.x + 280,  rect.y, 120);
    };
    
    Window_Base.prototype.drawActorWp = function(actor, x, y, width) {
        var color1 = this.textColor(14);
        var color2 = this.textColor(6);
        this.drawGauge(x, y, width, actor.wpRate(), color1, color2);
        this.changeTextColor(this.systemColor());
        this.drawText("Time", x, y, 88);
    };

    //
    // 'wp' parameter
    //

    Object.defineProperty(Game_BattlerBase.prototype, 'wp', {
        get: function() { return this._wp; },
        configurable: true,
    });

    var _Game_BattlerBase_initMembers = Game_BattlerBase.prototype.initMembers;
    Game_BattlerBase.prototype.initMembers = function() {
        this._wp = 0;
        _Game_BattlerBase_initMembers.call(this);
    };

    Game_BattlerBase.prototype.wpRate = function() {
        return (this.wp / MAX_WP).clamp(0, 1);
    };

    Game_BattlerBase.prototype.setWp = function(wp) {
        this._wp = wp;
        this.refresh();
    };

    var _Game_Battler_onBattleStart = Game_Battler.prototype.onBattleStart;
    Game_Battler.prototype.onBattleStart = function() {
        _Game_Battler_onBattleStart.call(this);
        this.setWp(Math.randomInt(MAX_WP / 2));
    };

    Game_Battler.prototype.gainWp = function(value) {
        // TODO: Invert |value| if needed (see gainTp())
        this.setWp(this.wp + value);
    };

    //
    // System
    //

    Game_Battler.prototype.onTurnEnd = function() {
        this.clearResult();
    };

    Game_Battler.prototype.onTurnStart = function() {
        this.updateStateTurns();
        this.updateBuffTurns();
        this.removeStatesAuto(2);
    };

    Game_Battler.prototype.onRegeneration = function() {
        this.regenerateAll();
    };

    var _BattleManager_initMembers = BattleManager.initMembers;
    BattleManager.initMembers = function() {
        _BattleManager_initMembers.call(this);
        this._turnWp = 0;
        this._turnEndSubject = null;
    };

    var _BattleManager_startBattle = BattleManager.startBattle;
    BattleManager.startBattle = function() {
        _BattleManager_startBattle.call(this);
        if (this._preemptive) {
            $gameParty.members().forEach(function(member) {
                member.setWp(MAX_WP);
            });
        }
        if (this._surprise) {
            $gameTroop.members().forEach(function(member) {
                member.setWp(MAX_WP);
            });
        }
        this._preemptive = false;
        this._surprise = false;
        this._phase = 'waiting';
        this._turnWp = 0;
    };

    BattleManager.makeActionOrders = function() {
        throw 'not reach';
    };

    var _BattleManager_update = BattleManager.update;
    BattleManager.update = function() {
        _BattleManager_update.call(this);
        if (!this.isBusy() && !this.updateEvent()) {
            switch (this._phase) {
            case 'waiting':
                this.updateWaiting();
                break;
            }
        }
    };

    function evalWpRate(battler, battlers) {
        var a = battler;
        return Math.max(eval(formula), 0);
    }

    BattleManager.updateWaiting = function() {
        $gameParty.requestMotionRefresh();

        var activeBattlers = this.allBattleMembers().filter(function(battler) {
            return battler.canMove();
        });
        var averageWpDelta = MAX_WP / AVERAGE_TIME / Math.sqrt(activeBattlers.length);

        this._turnEndSubject = null;

        this._turnWp += averageWpDelta.clamp(0, MAX_WP)|0;
        if (this._turnWp >= MAX_WP) {
            this._turnWp -= MAX_WP;
            // TODO: Check events work correctly.
            $gameTroop.increaseTurn();
            activeBattlers.forEach(function(battler) {
                battler.onRegeneration();
                this.refreshStatus();
                this._logWindow.displayAutoAffectedStatus(battler);
                this._logWindow.displayRegeneration(battler);
            }, this);
        }
        if ($gameParty.isEmpty() || this.isAborting() ||
            $gameParty.isAllDead() || $gameTroop.isAllDead()) {
            this._phase = 'turnEnd';
            return;
        }

        var someoneHasTurn = activeBattlers.some(function(battler) {
            return battler.wp >= MAX_WP;
        });

        if (!someoneHasTurn) {
            activeBattlers.forEach(function(battler) {
                var rate = evalWpRate(battler, activeBattlers);
                var delta = (averageWpDelta * rate).clamp(0, MAX_WP)|0;
                battler.gainWp(delta);
            });
        }
        // TODO: Sort battlers here?
        activeBattlers.some(function(battler) {
            if (battler.wp < MAX_WP) {
                return false;
            }
            battler.onTurnStart();

            this.refreshStatus();
            this._logWindow.displayAutoAffectedStatus(battler);
            // TODO: What if the battler becomes inactive?
            this._subject = battler;
            this._turnEndSubject = battler;
            battler.makeActions();
            if (battler.isActor() && battler.canInput()) {
                battler.setActionState('inputting');
                this._actorIndex = battler.index();
                this._phase = 'input';
                return true;
            }
            this._phase = 'turn';
            return true;
        }, this);
        this.refreshStatus();
    };

    // TODO: override processTurn?

    BattleManager.updateTurnEnd = function() {
        this._phase = 'waiting';
    };

    BattleManager.getNextSubject = function() {
        return null;
    };

    BattleManager.selectNextCommand = function() {
        do {
            if (!this.actor().selectNextCommand()) {
                if (!this.isEscaped()) {
                    this._phase = 'turn';
                }
                $gameParty.requestMotionRefresh();
                break;
            }
        } while (!this.actor().canInput());
    };

    BattleManager.selectPreviousCommand = function() {
        do {
            if (!this.actor().selectPreviousCommand()) {
                return;
            }
        } while (!this.actor().canInput());
    };

    BattleManager.endTurn = function() {
        this._phase = 'turnEnd';
        if (this._turnEndSubject) {
            this._turnEndSubject.setWp(this._turnEndSubject.wp - MAX_WP);
            this._turnEndSubject.onTurnEnd();
            this._turnEndSubject.setActionState('undecided');
        }
    };

    BattleManager.startInput = function() {
        throw 'not reach';
    };

    BattleManager.startTurn = function() {
        // Do nothing. This can reach when 'escape' command is selected.
    };
})();
