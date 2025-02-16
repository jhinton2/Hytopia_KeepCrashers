import { Player, EventRouter, EntityManager, Light, Vector3, PlayerUI, Entity, PlayerManager, RigidBodyType, World, Quaternion, PlayerCameraMode, Audio } from 'hytopia';
import { Team } from './Team';
import { PlayerEvents, type PlayerDeathEventPayload } from './events';
import { PlayerEntity } from 'hytopia';
import AbilityEntityController from './AbilityEntityController';
import { SceneUI } from 'hytopia';

import { ArcherAbilityController, FighterAbilityController, WizardAbilityController } from './PlayerClass';
import { DamageableEntity } from './DamageableEntity';
import { world } from './GlobalContext';
import { RespawnSystem } from './RespawnSystem';
import { GameState } from './GameState';
import { GameStateController } from './GameStateController';
import { CapturePoint } from './CapturePoint';
import { GameModeController } from './GameModeController';
import { KingOfTheHill } from './GameModeController';
import { HealthPickup } from './pickups/HealthPickup';

export class GameManager {
    private static readonly GAME_SFX = {
        COUNTDOWN: {
            uri: 'audio/sfx/voice/jack/jack_countdown.mp3',
            volume: 0.7
        },
        MATCH_START: {
            uri: 'audio/sfx/voice/jack/attack!.wav',
            volume: 0.8
        },
        POINT_CAPTURE: {
            uri: 'audio/sfx/game/Powerup upgrade 33.wav',
            volume: 0.8
        },
        MATCH_END: {
            uri: 'audio/sfx/game/Success 3.wav',
            volume: 0.8
        }
    };

    private readonly teams: Team[] = [
        new Team('Red', '#f15b5b'), 
        new Team('Blue', '#5f92f1')
    ];
    private players: Map<string, DamageableEntity> = new Map();
    private keepLight: Light;
    private localPlayer: DamageableEntity | undefined;
    private gameMusic: Audio | undefined;
    private gameMusicBattle: Audio | undefined;
    private readonly SPAWN_DAMAGE_INTERVAL = 1000; // Damage every 500ms
    private readonly SPAWN_DAMAGE_AMOUNT = 100;
    private lastSpawnDamageTime: Map<string, number> = new Map();

    // Add team spawn areas
    private teamSpawnAreas: Map<string, { min: Vector3, max: Vector3 }> = new Map([
        ['Red', { min: new Vector3(-30, 3, 53), max: new Vector3(-4, 3, 61) }],
        //['Blue', { min: new Vector3(-4, 3, 53), max: new Vector3(-30, 3, 61) }],
        ['Blue', { min: new Vector3(4, 3, -62), max: new Vector3(31, 3, -53) }]
    ]);

    private doors: Entity[] = [];

    private gameStateController: GameStateController;

    // Add to existing properties
    private capturePoints: CapturePoint[] = [];
    private gameModeController!: GameModeController;

    constructor(private readonly worldEventRouter: EventRouter) {
        // Initialize the keep light
        this.keepLight = new Light({
            position: new Vector3(0, 4.1, 0),
            color: { r: 255, g: 255, b: 255 },
            intensity: 15,
            distance: 12,
        });
        this.keepLight.spawn(world);

        this.gameStateController = new GameStateController(worldEventRouter);
        this.initGame();
        this.startGameLoop();
        this.setupEventListeners();
        
        // Add debug log
        console.log('Setting up UI_LOADED listener');
        
        
    }

    private playSongBattleMusic() {

        if (this.gameMusic) {
            this.gameMusic.pause();
        }

        if (!this.gameMusicBattle) {
            this.gameMusicBattle = new Audio({
                uri: 'audio/music/Good Day To Die.mp3',
                loop: true, // Loop the music when it ends
                volume: 0.1, // Relative volume 0 to 1
            });
        }

        this.gameMusicBattle.play(world); // Play the music in our world
    }

    

    private playSongMusic() {

        if (this.gameMusicBattle) {
            this.gameMusicBattle.pause();
        }

        if (!this.gameMusic) {
            this.gameMusic = new Audio({
                uri: 'audio/music/jungle-theme.mp3',
                loop: true, // Loop the music when it ends
                volume: 0.1, // Relative volume 0 to 1
            });
        }

        this.gameMusic.play(world); // Play the music in our world
    }


    private initGame() {
        // Initialize game mode
        const controlPoint = new CapturePoint(new Vector3(0, 2.15, 0), 8, 10, 5);
        controlPoint.spawn(world);
        this.gameModeController = new KingOfTheHill(this, this.worldEventRouter, controlPoint);

        /*
        this.gameMusic = new Audio({
            uri: 'audio/music/jungle-theme.mp3',
            loop: true, // Loop the music when it ends
            volume: 0.2, // Relative volume 0 to 1
        });

        this.gameMusic.play(world); // Play the music in our world
        */
        this.playSongMusic();

        // respawn system
        new RespawnSystem(world.eventRouter);


        this.buildStartAreaDoors(world);

        this.capturePoints.push(controlPoint);

        this.buildHealthPickup();

    }


    private startGameLoop() {
        setInterval(() => {
            this.gameModeController.update(1); // Update game mode with deltaTime
            this.updateStatsUI();
            this.gameStateController.update(this.players.size);
            this.worldEventRouter.emit('STAT_REGENERATION_TICK', undefined);
            this.CheckIfPlayerIsInEnemySpawn(1);
        }, 1000);
    }

    private setupEventListeners() {
        

        this.worldEventRouter.on('PLAYER_READY_UPDATE', (data: { playerId: string, isReady: boolean }) => {
            console.log(`PLAYER_READY_UPDATE ${data.playerId} ${data.isReady}!`);
        });
        
        this.worldEventRouter.on('GAME_STATE_CHANGED', (newState: GameState) => {
            console.log(`GAME_STATE_CHANGED ${newState}!`);
            
            this.updatePlayerUI();

            if (newState === GameState.MatchStats) {
                this.buildStartAreaDoors(world);
                this.updateKeepLightColor(null);
                this.playSongMusic();

            }

            if (newState === GameState.MatchPlay) {
                this.playSongBattleMusic();
            }
        });


       

        this.worldEventRouter.on('MATCH_COUNTDOWN_UPDATE', (timeLeft: number) => {
            this.updatePlayerUI();
        });

        this.worldEventRouter.on('MATCH_TIME_UPDATE', (timeLeft: number) => {
            this.updatePlayerUI();
        });

        world?.eventRouter.on<PlayerDeathEventPayload>(PlayerEvents.Death, (payload) => {
            payload.victim.matchStats.addDeath();

            if (payload.killer) {
                if (payload.killer === payload.victim) {
                    payload.victim.matchStats.addSuicide();
                } else {
                    payload.killer.matchStats.addKill();
                }
            }

            setTimeout(() => {
                this.setPlayerToTeamSpawnArea(payload.victim);
            }, 1500);


            this.updateStatsUI();
        });

       
    }



    public updatePlayerUI() {
        this.players.forEach(entity => {
            entity.player.ui.sendData({
                type: 'gameStateUpdate',
                state: this.gameStateController.getState(),
                message: this.gameStateController.getStateMessage(),
                isReady: this.gameStateController.isPlayerReady(entity.player.id)
            });
        });
    }

    public updateStatsUI() {
        const players = Array.from(this.players.values());
        const captureData = {
            progress: this.gameModeController.getCaptureProgress(),
            teamColor: this.gameModeController.getCapturePoint()?.partialControlTeam?.color 
                || this.gameModeController.getCurrentControllingTeam()?.color 
                || '#666',
            teamName: this.gameModeController.getCurrentControllingTeam()?.name || 'Neutral'
        };

        // Send match stats update
        const teamStats = {
            Red: players.filter(p => this.getPlayerTeam(p.player)?.name === 'Red')
                     .map(p => ({ 
                         username: p.player.username, 
                         kills: p.matchStats.kills,
                         deaths: p.matchStats.deaths 
                     })),
            Blue: players.filter(p => this.getPlayerTeam(p.player)?.name === 'Blue')
                      .map(p => ({
                          username: p.player.username,
                          kills: p.matchStats.kills,
                          deaths: p.matchStats.deaths
                      })),
            capturePoint: captureData
        };

        // Send both stats updates to each player
        this.players.forEach(entity => {
            if (entity instanceof DamageableEntity) {
                // Send player stats
                entity.player.ui.sendData({
                    type: 'statsUpdate',
                    health: entity.health,
                    stamina: entity.stamina,
                    mana: entity.mana
                });

                // Send match stats
                entity.player.ui.sendData({
                    type: 'matchStatsUpdate',
                    teams: teamStats,
                    capturePoint: teamStats.capturePoint,
                    redTime: this.gameModeController.getTeamTime('Red'),
                    blueTime: this.gameModeController.getTeamTime('Blue'),
                    overtime: this.gameModeController.isInOvertime
                });
            }
        });
    }

    public InitPlayerEntity(player: Player) {

        console.log('InitPlayerEntity ' + player.username);
        const team = this.assignPlayerToTeam(player);
        this.worldEventRouter.emit('PLAYER_ASSIGNED', { player, team });
        
        
        // Create entity controller first
        const entityController = new AbilityEntityController();

        const playerModel = team.name === 'Red' ? 'models/players/red_player.gltf' : 'models/players/blue_player.gltf';

        // Create player entity with controller
        const playerEntity = new DamageableEntity({
            player,
            name: 'Player',
            modelUri: playerModel,
        
            modelLoopedAnimations: ['idle'],
            modelScale: 0.5,
            controller: entityController, // Use the entity controller
        }, 100, 100, 100);

        
        // Get spawn position based on team
        const spawnPosition = this.getTeamSpawnPosition(team.name);
        playerEntity.spawn(world, spawnPosition);
        
        //this.localPlayer = playerEntity;


        // Set initial class
        entityController.setClass('wizard');

        /*
        const keepLight = new Light({
            //attachedToEntity: playerEntity, // the entity to follow
            position: new Vector3(0, 4.1, 0),
            color: { r: 255, g: 255, b: 255 },
            intensity: 15,
            distance: 12,
        });
        */

        //playerEntity.light = light;

        //keepLight.spawn(world);
        //light.

        this.InitCamera(playerEntity);

        this.InitUI(playerEntity);
       
        // Add to player map
        this.addPlayer(player, playerEntity);

        this.worldEventRouter.emit('PLAYER.CREATED', playerEntity);

        // Updated UI handler
        playerEntity.player.ui.onData = (playerUI: PlayerUI, data: Record<string, any>) => {
            //console.log('Got data from player UI:', data);

            if (data.type === 'PLAYER_READY') {
                this.setPlayerReady(player.id, true);
                playerUI.sendData({
                    type: 'gameStateUpdate',
                    state: this.gameStateController.getState(),
                    message: this.gameStateController.getStateMessage(),
                    isReady: true
                });
            }
            
            // Add proper CLASS_CHANGE handler
            if (data.type === 'CLASS_CHANGE') {
                this.handleClassChange(player, data.className);
            }

            if (data.type === 'TOGGLE_POINTER_LOCK') {
                playerUI.lockPointer(!data.enabled);
            }

            if (data.type === 'MENU_SYSTEM_READY') {
                console.log('InitUI: Initializing client-side menu system');
               //this.menuSystem.initializeOnClient(data.containerId);
            }
        };
    }

    public InitUI(entity: PlayerEntity) {
        entity.player.ui.load('ui/stats.html');
       
        const team = this.getPlayerTeam(entity.player);
        const teamColor = team?.color || '#ffffff';

        // Disable nameplate UI for now
        /*
        const nameplateUI = new SceneUI({
            templateId: 'player-nameplate',
            attachedToEntity: entity,
            offset: { x: 0, y: 1.2, z: 0 },
            state: {
                name: entity.player.username.substring(0, 15),
                health: 100,
                teamColor: teamColor
            }
        });

        nameplateUI.load(world);
        (entity as DamageableEntity).nameplateUI = nameplateUI;
        */
    }

    
    public InitCamera(entity: PlayerEntity) {

        entity.player.camera.setMode(PlayerCameraMode.FIRST_PERSON);
        entity.player.camera.setFilmOffset(8);

        entity.player.camera.setForwardOffset(-2.5)
        entity.player.camera.setOffset({ x: 0, y: 0.8, z: 0 });
        entity.player.camera.setZoom(1.3);
        entity.player.camera.setFov(75 );
    }

    public assignPlayerToTeam(player: Player): Team {
        let smallestTeam = this.teams[0];
        for (const team of this.teams) {
            if (team.players.length < smallestTeam.players.length) {
                smallestTeam = team;
            }
        }
        
        // Add player to the team
        smallestTeam.players.push(player);
        console.log(`Assigned ${player.username} to ${smallestTeam.name} team`);
        return smallestTeam;
    }


    public removePlayerFromTeam(player: Player) {
        for (const team of this.teams) {
            team.players = team.players.filter(p => p !== player);
        }
    }

    public getPlayerTeam(player: Player): Team | undefined {
        return this.teams.find(team => team.players.includes(player));
    }

    public getPlayerEntity(playerId: string): DamageableEntity | undefined {
        return this.players.get(playerId);
    }

    public getAllPlayers(): IterableIterator<DamageableEntity> {
        return this.players.values();
    }
    public getPlayers(): Map<string, DamageableEntity> {
        return this.players;
    }

    public addPlayer(player: Player, entity: DamageableEntity) {
        this.players.set(player.id, entity);
    }

    public removePlayer(playerId: string) {
        const entity = this.players.get(playerId);
        if (entity) {
            // Cleanup UI elements
            if (entity.nameplateUI) {
                entity.nameplateUI.unload();
            }
            // Destroy entity if needed
            if (entity.isSpawned) {
                entity.despawn();
            }

            this.players.delete(playerId);
        }
    }

    public setPlayerToTeamSpawnArea(entity: PlayerEntity) {
        const team = this.getPlayerTeam(entity.player);
        const spawnPosition = this.getTeamSpawnPosition(team?.name || 'Red');
        entity.setPosition(spawnPosition);
    }

    private getTeamSpawnPosition(teamName: string): Vector3 {
        const spawnArea = this.teamSpawnAreas.get(teamName);

        if (!spawnArea) {
            throw new Error(`No spawn area defined for team ${teamName}`);
        }

        // Get random position within the spawn area
        return new Vector3(
            spawnArea.min.x + Math.random() * (spawnArea.max.x - spawnArea.min.x),
            spawnArea.min.y + Math.random() * (spawnArea.max.y - spawnArea.min.y),
            spawnArea.min.z + Math.random() * (spawnArea.max.z - spawnArea.min.z)
        );
    }

    // Add method to set spawn areas
    public setTeamSpawnArea(teamName: string, min: Vector3, max: Vector3) {
        this.teamSpawnAreas.set(teamName, { min, max });
    }

    private buildCapturePoint(world: World, position: Vector3): CapturePoint {
        // Add capture point
        const mainCapturePoint = new CapturePoint(position, 8, 10, 0.5);
        mainCapturePoint.spawn(world);
        this.capturePoints.push(mainCapturePoint);


        return mainCapturePoint;
    }

    private buildDoor(world: World, position: Vector3, rotation: Quaternion): Entity {
        const door = new Entity({
            modelUri: 'models/structures/door_start_area.gltf',
            modelScale: 4,
            rigidBodyOptions: {
                type: RigidBodyType.KINEMATIC_POSITION,
            },
        });

        door.spawn(world, position);
        door.setRotation(rotation);
        
        this.doors.push(door);
        return door;
    }

    public buildStartAreaDoors(world: World) {

        let redDepthZ = 51.5;
        let blueDepthZ = 50.5;

        const heightY = 4;
        
        // Create doors and add them to the list
        this.buildDoor(world, new Vector3(-18, heightY, redDepthZ), new Quaternion(0, 0, 0, 0));
        this.buildDoor(world, new Vector3(-4, heightY, redDepthZ), new Quaternion(0, 0, 0, 0));
        this.buildDoor(world, new Vector3(-30, heightY, redDepthZ), new Quaternion(0, 0, 0, 0));

        this.buildDoor(world, new Vector3(19, heightY, blueDepthZ * -1), new Quaternion(0, 0, 0, 0));
        this.buildDoor(world, new Vector3(5, heightY, blueDepthZ * -1), new Quaternion(0, 0, 0, 0));
        this.buildDoor(world, new Vector3(31, heightY, blueDepthZ * -1), new Quaternion(0, 0, 0, 0));


        

    }

    private buildHealthPickup() {
        

        // Blue Team Small outpost
        new HealthPickup({
            size: 'large',
            position: new Vector3(-20, 4.5, -24),
            respawnTime: 10  // Respawns after 45 seconds
        });

        //Red Team Large outpost
        new HealthPickup({
            size: 'large',
            position: new Vector3(21, 4.5, 24),
            respawnTime: 10  // Respawns after 20 seconds
        });


        // red Team House Top
        new HealthPickup({
            size: 'large',
            position: new Vector3(-30.5, 9.5, 17.5),
            respawnTime: 10  // Respawns after 45 seconds
        });

        //Blue Team House TOp
        new HealthPickup({
            size: 'large',
            position: new Vector3(31.5, 9.5, -17),
            respawnTime: 10  // Respawns after 20 seconds
        });
    }



    public getDoors(): Entity[] {
        return this.doors;
    }

    public openDoors(open: boolean = true) {
    
        this.doors.forEach(door => {
            //door.setPosition(new Vector3(0, open ? 90 : 0, 0));
            door.despawn();
        });

        this.doors = [];
    
    }   
    

    // Add these methods to your existing GameManager class
    public setPlayerReady(playerId: string, isReady: boolean) {
        this.gameStateController.setPlayerReady(playerId, isReady);
        
    }

    private lockTeamSwitching(locked: boolean) {
        this.worldEventRouter.emit('TEAM_SWITCHING_LOCKED', locked);
    }

    private lockCharacterSelection(locked: boolean) {
        this.worldEventRouter.emit('CHARACTER_SELECTION_LOCKED', locked);
    }

    

    public resetMatch() {
        // Reset player positions and stats
        this.players.forEach(player => {
            player.respawn();
            const spawnPos = this.getTeamSpawnPosition(this.getPlayerTeam(player.player)?.name || 'Red');
            player.setPosition(spawnPos);
        });
        
        // Clear any game mode specific state
        this.gameModeController.reset();
    }

    public getTeam(teamName: string): Team | undefined {
        return this.teams.find(t => t.name === teamName);
    }

    public handleGameWin(winningTeam: Team) {
        console.log(`${winningTeam.name} team wins!`);
        
        this.players.forEach(player => {
            player.player.ui.sendData({
                type: 'gameOverSequence',
                state: GameState.MatchEnd,
                winningTeam: winningTeam.name,
                teamColor: winningTeam.color
            });

        });
        this.gameStateController.setState(GameState.MatchEnd);
    }

    public getGameState(): GameState {
        return this.gameStateController.getState();
    }

    public handleClassChange(player: Player, className: string) {
        const entity = this.players.get(player.id);
        if (entity?.controller instanceof AbilityEntityController) {
            entity.controller.setClass(className);
        }
    }

    public showStats() {
        this.players.forEach(player => {
            player.player.ui.sendData({
                type: 'TOGGLE_MENU',
                menuId: 'stats'
            });
        });
    }

    private playGameSound(soundEffect: { uri: string, volume: number }) {
        if (world) {
            const sound = new Audio({
                uri: soundEffect.uri,
                volume: soundEffect.volume
            });
            sound.play(world);
        }
    }

    public handleGameStateChange(newState: GameState) {
        switch (newState) {
            case GameState.MatchStartCountdown:
                this.playGameSound(GameManager.GAME_SFX.COUNTDOWN);
                break;
            case GameState.MatchPlay:
                this.playGameSound(GameManager.GAME_SFX.MATCH_START);
                break;
            case GameState.MatchEnd:
                this.playGameSound(GameManager.GAME_SFX.MATCH_END);
                break;
        }
    }

    public handlePointCapture(team: Team | null) {
        this.playGameSound(GameManager.GAME_SFX.POINT_CAPTURE);
        this.updateKeepLightColor(team);
    }

    // Add method to update keep light color
    private updateKeepLightColor(team: Team | null) {
        if (!team) {
            // Neutral - white light
            this.keepLight.setColor({ r: 255, g: 255, b: 255 });
            return;
        }

        // Convert hex color to RGB
        const hex = team.color.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        this.keepLight.setColor({ r, g, b });
    }

    // Add method to check if player is in their team's spawn area
    public isPlayerInSpawnArea(player?: Player): boolean {
        if (!player) return false;
        
        const entity = this.players.get(player.id);
        if (!entity) return false;
        
        const team = this.getPlayerTeam(player);
        if (!team) return false;
        
        const spawnArea = this.teamSpawnAreas.get(team.name);
        
        if (!spawnArea) return false;
        
        const pos = entity.position;
        const isInSpawn = this.isPointInSpawnArea(new Vector3(pos.x, pos.y, pos.z), team);

        return isInSpawn;

    }

    public isPointInSpawnArea(point: Vector3, team: Team, expandX: number = 0, expandZ: number = 0) {
        const spawnArea = this.teamSpawnAreas.get(team.name);
        if (!spawnArea) return false;
        
        // Expand the boundaries by the specified range
        const expandedMin = new Vector3(
            spawnArea.min.x - expandX,
            spawnArea.min.y,
            spawnArea.min.z - expandZ
        );
        const expandedMax = new Vector3(
            spawnArea.max.x + expandX,
            spawnArea.max.y,
            spawnArea.max.z + expandZ
        );
        
        return (point.x >= expandedMin.x && point.x <= expandedMax.x) &&
            (point.z >= expandedMin.z && point.z <= expandedMax.z);
    }

    // Add method to check if player is in enemy spawn
    private isPlayerInEnemySpawn(player: Player, expandX: number = 0, expandZ: number = 0): boolean {
        const playerTeam = this.getPlayerTeam(player);
        if (!playerTeam) return false;
        
        // Get enemy team
        const enemyTeam = this.teams.find(t => t.name !== playerTeam.name);
        if (!enemyTeam) return false;
        
        return this.isPointInSpawnArea(
            Vector3.fromVector3Like(this.players.get(player.id)?.position!), 
            enemyTeam,
            expandX,
            expandZ
        );
    }

    public CheckIfPlayerIsInEnemySpawn(deltaMs: number) {
        const currentTime = Date.now();
        
        // Check each player for spawn area damage
        this.players.forEach((entity, playerId) => {
            if (!entity.player) return;
            
            const lastDamageTime = this.lastSpawnDamageTime.get(playerId) || 0;
            if (currentTime - lastDamageTime >= this.SPAWN_DAMAGE_INTERVAL) {
                if (this.isPlayerInEnemySpawn(entity.player, 3, 7)) { // Expand X by 3, Z by 5
                    entity.takeDamage(this.SPAWN_DAMAGE_AMOUNT);
                    this.lastSpawnDamageTime.set(playerId, currentTime);
                }
            }
        });

        // ... rest of tick logic
    }

}