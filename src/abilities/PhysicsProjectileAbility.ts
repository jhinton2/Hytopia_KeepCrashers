import { Entity, EventRouter, Vector3, type Vector3Like, RigidBodyType, ColliderShape, CollisionGroup, BlockType, type QuaternionLike, PlayerEntity } from 'hytopia';
import { Ability } from '../Ability';
import { type PhysicsProjectileOptions } from './AbilityOptions';
import { DamageableEntity } from '../DamageableEntity';
import { faceDirection, getRotationFromDirection } from '../utils/math';
import { world } from '../GlobalContext';
import { ParticleEmitter } from '../particles/ParticleEmitter';
import { ParticleFX } from '../particles/ParticleFX';
import { Collider } from 'hytopia';
import type { AbilityController } from '../AbilityController';


export class PhysicsProjectileAbility extends Ability {
    constructor(
        public options: PhysicsProjectileOptions,
        eventRouter: EventRouter,
        abilityController: AbilityController
    ) {
        super(options, eventRouter, abilityController);
    }

    

    use(origin: Vector3Like, direction: Vector3Like, source: Entity) {
        if (!source.world) return;

        const chargeLevel = this.endCharge(); // Get final charge level and reset charging state

        // Apply charge effects
        let { speed, damage, gravityScale } = this.getChargedValues(chargeLevel);
        let size = 0;

        if (this.options.charging?.chargeEffects) {
            const effects = this.options.charging.chargeEffects;
            
            if (effects.speed) {
                speed = this.getChargedValue(chargeLevel, effects.speed.min, effects.speed.max);
            }
            if (effects.damage) {
                damage = this.getChargedValue(chargeLevel, effects.damage.min, effects.damage.max);
            }
            if (effects.gravity) {
                gravityScale = this.getChargedValue(chargeLevel, effects.gravity.min, effects.gravity.max);
            }
            if (effects.size) {
                size = this.getChargedValue(chargeLevel, effects.size.min, effects.size.max);
            }
        }

        // Normalize and scale direction vector
        const directionVector = new Vector3(direction.x, direction.y, direction.z).normalize();
        const velocityVector = directionVector.scale(speed);

        const projectile = new Entity({
            name: `${this.options.name} Projectile`,
            modelUri: this.options.modelUri,
            modelScale: this.options.modelScale + size,
            rigidBodyOptions: {
                type: RigidBodyType.DYNAMIC,
                linearVelocity: velocityVector,
                gravityScale: gravityScale,
                
            },

        });

        let age = 0;
        let maxLifetime = this.options.lifeTime; // Use lifetime if specified
        if (typeof maxLifetime === 'undefined') {
            if (this.options.maxRange === -1) {
                maxLifetime = Infinity; // No range limit and no lifetime = never expire
            } else {
                maxLifetime = this.options.maxRange / speed; // Default range-based lifetime
            }
        }

        projectile.onTick = (entity: Entity, tickDeltaMs: number) => {
            // Custom tick handler if provided
            if (this.options.onProjectileTick) {
                this.options.onProjectileTick(entity, tickDeltaMs);
            }

            // Update age in seconds
            age += tickDeltaMs / 1000;

            const currentVelocity = entity.linearVelocity;
            
            // Check if the projectile is moving (non-zero velocity)
            if (currentVelocity.x !== 0 || currentVelocity.y !== 0 || currentVelocity.z !== 0) {
                // Set the projectile's rotation
                projectile.setRotation(faceDirection(currentVelocity));
            }
            
            // Despawn if exceeded lifetime
            if (age >= maxLifetime) {
                this.projectileEnd(projectile, source);
            }
        };


        projectile.createAndAddChildCollider({
            shape: ColliderShape.BALL,
            radius: this.options.projectileRadius,
            friction: 0.6,
            bounciness: 1,
            collisionGroups: {
                belongsTo: [CollisionGroup.ENTITY],
                collidesWith: [CollisionGroup.ENTITY, CollisionGroup.BLOCK],
            },

            

            onCollision: (otherEntity: Entity | BlockType, started: boolean) => {
                if (!started) return;
                if (otherEntity == source) return;
                
                if (this.options.noHitOnBlockCollision && otherEntity instanceof BlockType) {
                    return;
                }

                if (this.options.noHitOnEntityCollision && otherEntity instanceof PlayerEntity) {
                    return;
                }

                if (this.options.onCollision) {
                    this.options.onCollision(source, otherEntity);
                }
                else if (otherEntity instanceof DamageableEntity && !otherEntity.isDead()) {

                    otherEntity.takeDamage(damage, source as DamageableEntity);
                    otherEntity.applyImpulse(velocityVector.scale(this.options.knockback));
                    if (otherEntity instanceof DamageableEntity) {
                        this.spawnEffect(new ParticleEmitter(ParticleFX.BLOODHIT), otherEntity.position as Vector3);
                    }   

                }
                
                this.projectileEnd(projectile, source);

                world.eventRouter.emit('ProjectileHit', {
                    type: source.name,
                    source,
                    target: otherEntity instanceof Entity ? otherEntity : undefined,
                    damage: this.options.damage
                });

                //projectile.despawn();
            }
        });
       
        projectile.spawn(source.world, origin);

       
        if (this.options.useFX) {
            this.spawnEffect(new ParticleEmitter(this.options.useFX), origin);
        }
    }

    private projectileEnd(projectile: Entity, source: Entity) {

        // Handle AOE damage with collider
        this.handleAOEDamage(projectile.position as Vector3Like, source as DamageableEntity);

        // Visual effects
        if (this.options.hitFX) {
            this.spawnEffect(new ParticleEmitter(this.options.hitFX), projectile.position as Vector3);
        }

        
        projectile.despawn();
    }

    private handleAOEDamage(position: Vector3Like, source: DamageableEntity) {
        if (!this.options.aoe) return;


        // Create a spherical collider for AOE detection
        const aoeCollider = new Collider({
            shape: ColliderShape.BALL,
            radius: this.options.aoe.radius,
            isSensor: true,
            relativePosition: position,
            onCollision: (other: Entity | BlockType, started: boolean) => {
                if (!started) return;

                // Skip if not a damageable entity or already dead
                if (!(other instanceof DamageableEntity) || other.isDead()) return;

                let damage = this.options.aoe!.damage;
                let knockback = this.options.aoe!.knockback ?? 0;

                if (this.options.aoe!.falloff) {
                    // Calculate distance-based falloff
                    const distance = Vector3.fromVector3Like(position).distance(Vector3.fromVector3Like(other.position));
                    const falloffFactor = 1 - (distance / this.options.aoe!.radius);
                    damage *= Math.max(0, falloffFactor); // Ensure non-negative
                    knockback *= falloffFactor;
                }

                // Apply damage and knockback
                other.takeDamage(damage, source);

                if (knockback > 0) {
                    const direction = Vector3.fromVector3Like(other.position)
                        .subtract(Vector3.fromVector3Like(position))
                        .normalize();
                    other.applyImpulse(direction.scale(knockback));
                }
            }
        });

        // Add collider to simulation
        aoeCollider.addToSimulation(world.simulation);

        // Remove collider after a short delay
        setTimeout(() => {
            aoeCollider.removeFromSimulation();
        }, 100); // 100ms should be enough to detect all collisions
    }

    public spawnEffect(effect: ParticleEmitter, position: Vector3Like) {
        
        effect.spawn(world, position);
        effect.burst();

        //(() => effect.destroy(), effect.particleOptions.lifetime * 1000);
    }


    private getChargedValues(chargeLevel: number) {
        let speed = this.options.speed;
        let damage = this.options.damage;
        let gravityScale = this.options.gravityScale ?? 1;

        if (this.options.charging?.chargeEffects) {
            const { speed: s, damage: d, gravity: g } = this.options.charging.chargeEffects;
            if (s) speed = this.getChargedValue(chargeLevel, s.min, s.max);
            if (d) damage = this.getChargedValue(chargeLevel, d.min, d.max);
            if (g) gravityScale = this.getChargedValue(chargeLevel, g.min, g.max);
        }

        return { speed, damage, gravityScale };
    }

    
} 