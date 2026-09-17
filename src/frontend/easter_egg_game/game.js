// acCompaniment-main/src/renderer/easter_egg_game/game.js

console.log("Pig Roundup Game JS Loaded!");

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('gameCanvas');
    if (!canvas) {
        console.error("Game canvas not found!");
        return;
    }
    const ctx = canvas.getContext('2d');

    // Set canvas internal resolution (different from display size if CSS scales it)
    canvas.width = 640;
    canvas.height = 480;

    console.log("Canvas initialized:", canvas.width, "x", canvas.height);

    // --- Game Assets ---
     const elmerSprite = new Image();
     elmerSprite.src = 'assets/farmer.png';
     const pigSprite = new Image();
     pigSprite.src = 'assets/pig.png';
     const barnSprite = new Image();
     barnSprite.src = 'assets/barn.png';

    // New Obstacle and Decoration Assets
    const tree1Sprite = new Image();
    tree1Sprite.src = 'assets/tree1.png';
    const tree2Sprite = new Image();
    tree2Sprite.src = 'assets/tree2.png';
    const fenceSprite = new Image();
    fenceSprite.src = 'assets/fence.png'; 
    const puddleSprite = new Image();
    puddleSprite.src = 'assets/puddle.png';
    const dirtSprite = new Image();
    dirtSprite.src = 'assets/dirt.png';

    // --- Game Configuration ---
    const PIG_SIZE = 24;
    const ELMER_SIZE = 32;
    const BARN_WIDTH = 80;
    const BARN_HEIGHT = 60;
    const PIG_FLEE_DISTANCE = 60; // Distance at which pigs start fleeing
    const PIG_FLEE_SPEED_MULTIPLIER = 1.5; // How much faster pigs move when fleeing
    const BARN_NO_SPAWN_PADDING = 30; // Pigs should not spawn this close to the barn edges
    const LEVEL_TRANSITION_DELAY = 2500; // Milliseconds for level complete message

    // Placeholder sizes for new assets (adjust as needed)
    const TREE1_SPRITE_WIDTH = 40, TREE1_SPRITE_HEIGHT = 60;
    const TREE1_COLLISION_WIDTH = 10, TREE1_COLLISION_HEIGHT = 45; // Tighter collision box
    const TREE2_SPRITE_WIDTH = 45, TREE2_SPRITE_HEIGHT = 65;
    const TREE2_COLLISION_WIDTH = 12, TREE2_COLLISION_HEIGHT = 50; // Tighter collision box

    const FENCE_SPRITE_WIDTH = 80, FENCE_SPRITE_HEIGHT = 30; // Assuming horizontal fence
    const FENCE_COLLISION_WIDTH = 80, FENCE_COLLISION_HEIGHT = 15; // Thinner collision for fence

    const PUDDLE_SIZE = 35;
    const DIRT_SIZE = 30;

    // --- Game State Variables ---
    let character = {
        x: canvas.width / 2 - ELMER_SIZE / 2,
        y: canvas.height - ELMER_SIZE - 10, // Start at bottom middle
        width: ELMER_SIZE,
        height: ELMER_SIZE,
        speed: 2,
        sprite: elmerSprite,
        dx: 0, // For nudge direction
        dy: 0
    };

    let pigs = [];
    let barn = {
        x: canvas.width / 2 - BARN_WIDTH / 2,
        y: 10, // At the top middle
        width: BARN_WIDTH,
        height: BARN_HEIGHT,
        sprite: barnSprite
    };

    let score = 0;
    let level = 1;
    let pigsToSpawn = 2;
    let gameRunning = true;
    let levelTransition = false;
    let levelTransitionTimer = null;
    let obstacles = [];
    let decorations = [];
    let waitingForNextLevelInput = false;

    // --- Input Handling ---
    const keysPressed = {};
    document.addEventListener('keydown', (e) => {
        keysPressed[e.key] = true;
    });
    document.addEventListener('keyup', (e) => {
        keysPressed[e.key] = false;
    });

    function handleInput() {
        if (waitingForNextLevelInput) {
            if (keysPressed['Enter']) {
                console.log("Enter pressed, advancing to next level.");
                level++; // Increment level number when player confirms
                levelTransition = false;
                waitingForNextLevelInput = false;
                gameRunning = true;
                // initializeLevel(level); // Level elements already set up by the timeout
                keysPressed['Enter'] = false; // Consume the key press
            }
            return; // Don't process game movement input while waiting
        }

        character.dx = 0;
        character.dy = 0;
        let moved = false;
        if (keysPressed['ArrowUp']) {
            character.y -= character.speed;
            character.dy = -1;
            moved = true;
        }
        if (keysPressed['ArrowDown']) {
            character.y += character.speed;
            character.dy = 1;
            moved = true;
        }
        if (keysPressed['ArrowLeft']) {
            character.x -= character.speed;
            character.dx = -1;
            moved = true;
        }
        if (keysPressed['ArrowRight']) {
            character.x += character.speed;
            character.dx = 1;
            moved = true;
        }
        if (!moved) {
            character.dx = 0;
            character.dy = 0;
        }
        // Keep character within canvas bounds
        character.x = Math.max(0, Math.min(canvas.width - character.width, character.x));
        character.y = Math.max(0, Math.min(canvas.height - character.height, character.y));
    }

    function handleObstacleCollision(movingObject, objectWidth, objectHeight, prevX, prevY) {
        let collided = false;
        for (const obstacle of obstacles) {
            if (isColliding({x: movingObject.x, y: movingObject.y, width: objectWidth, height: objectHeight}, obstacle)) {
                // More precise collision response: check axis of collision
                // Check X-axis collision first
                if (isColliding({x: prevX, y: movingObject.y, width: objectWidth, height: objectHeight}, obstacle)) {
                     movingObject.y = prevY; // Revert Y if X was already colliding
                } else {
                    movingObject.x = prevX; // Revert X if Y was fine
                }
                collided = true;
                // For pigs, also reverse direction slightly
                if (movingObject.vx !== undefined) { // Check if it's a pig
                    movingObject.vx *= -0.5; 
                    movingObject.vy *= -0.5; 
                }
                break; // Stop checking after first collision
            }
        }
        return collided;
    }

    // --- Collision Detection ---
    function isColliding(rect1, rect2) {
        return rect1.x < rect2.x + rect2.width &&
               rect1.x + rect1.width > rect2.x &&
               rect1.y < rect2.y + rect2.height &&
               rect1.y + rect1.height > rect2.y;
    }

    // --- Game Logic Updates ---
    function update() {
        const charXBeforeInput = character.x; // Store position BEFORE input processing
        const charYBeforeInput = character.y;

        handleInput(); // Processes keys and potentially changes character.x/y

        // Now, character.x/y is the NEW intended position.
        // If this new position collides, revert using charXBeforeInput, charYBeforeInput.
        handleObstacleCollision(character, character.width, character.height, charXBeforeInput, charYBeforeInput);

        if (levelTransition) {
            // If in level transition (message showing, possibly waiting for Enter), 
            // skip main game object updates.
            return;
        }

        if (!gameRunning) {
            // If game is not running (e.g. paused, or after level complete before Enter is handled by next input cycle)
            return;
        }

        // Pigs logic and other game running updates proceed here
        pigs.forEach((pig, index) => {
            const pigRect = { x: pig.x, y: pig.y, width: PIG_SIZE, height: PIG_SIZE };
            const prevPigX = pig.x;
            const prevPigY = pig.y;

            if (isColliding(character, pigRect)) {
                const PUSH_SPEED = character.speed * 0.8;
                if (character.dx !== 0) pig.x += character.dx * PUSH_SPEED;
                if (character.dy !== 0) pig.y += character.dy * PUSH_SPEED;
                
                pig.x = Math.max(0, Math.min(canvas.width - PIG_SIZE, pig.x));
                pig.y = Math.max(0, Math.min(canvas.height - PIG_SIZE, pig.y));
                pig.isBeingPushed = true;
            } else {
                pig.isBeingPushed = false; // Reset push state if not colliding with Elmer

                // Flee from Elmer if close
                const dxFarmer = pig.x + PIG_SIZE / 2 - (character.x + ELMER_SIZE / 2);
                const dyFarmer = pig.y + PIG_SIZE / 2 - (character.y + ELMER_SIZE / 2);
                const distanceToFarmer = Math.sqrt(dxFarmer * dxFarmer + dyFarmer * dyFarmer);

                if (distanceToFarmer < PIG_FLEE_DISTANCE) {
                    const fleeSpeed = pig.originalSpeed * PIG_FLEE_SPEED_MULTIPLIER;
                    pig.vx = (dxFarmer / distanceToFarmer) * fleeSpeed;
                    pig.vy = (dyFarmer / distanceToFarmer) * fleeSpeed;
                } else {
                    // Occasionally change direction if not fleeing and not pushed
                    if (Math.random() < 0.01) {
                        pig.vx = (Math.random() - 0.5) * pig.originalSpeed * 2; // Random speed based on original
                        pig.vy = (Math.random() - 0.5) * pig.originalSpeed * 2;
                    }
                }
                
                // Apply movement
                pig.x += pig.vx;
                pig.y += pig.vy;

                // Collision with obstacles for pigs
                if(handleObstacleCollision(pig, PIG_SIZE, PIG_SIZE, prevPigX, prevPigY)){
                    // Pig hit an obstacle, already handled by handleObstacleCollision (position reverted, velocity slightly reversed)
                } else {
                    // Bounce off walls if no obstacle collision occurred that axis
                    if (pig.x <= 0 || pig.x + PIG_SIZE >= canvas.width) {
                        pig.x = Math.max(0, Math.min(canvas.width - PIG_SIZE, pig.x));
                        pig.vx *= -1;
                    }
                    if (pig.y <= 0 || pig.y + PIG_SIZE >= canvas.height) {
                        pig.y = Math.max(0, Math.min(canvas.height - PIG_SIZE, pig.y));
                        pig.vy *= -1;
                    }
                }
            }

            // Check collision with Barn (scoring)
            if (isColliding(pigRect, barn)) {
                pigs.splice(index, 1); // Remove pig
                score++;
                console.log("Pig in barn! Score:", score);
            }
        });

        // Check for level completion
        if (pigs.length === 0 && gameRunning && !levelTransition) {
            levelTransition = true;
            gameRunning = false; // Pause game logic
            console.log(`Level ${level} complete! Displaying message.`);
            
            if (levelTransitionTimer) clearTimeout(levelTransitionTimer);
            levelTransitionTimer = setTimeout(() => {
                // level++; // Level is incremented when Enter is pressed
                pigsToSpawn += 1;
                character.speed += 0.25;
                console.log(`Level ${level + 1} prepared. Waiting for Enter key.`); // Log next level number
                initializeLevel(level + 1); // Initialize elements for the *next* actual level number
                waitingForNextLevelInput = true; // Now wait for player input
                // gameRunning remains false, levelTransition remains true until Enter
            }, LEVEL_TRANSITION_DELAY);
        }
    }

    // --- Drawing ---
    function draw() {
        // Clear canvas
        ctx.fillStyle = '#8FBC8F'; // DarkSeaGreen grass
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw Decorations (drawn first, so they are behind everything else)
        decorations.forEach(dec => {
            if (dec.sprite && dec.sprite.complete) {
                ctx.drawImage(dec.sprite, dec.x, dec.y, dec.width, dec.height);
            } else { // Fallback drawing for decorations
                ctx.fillStyle = '#A9A9A9'; // Example: DarkGray for fallback
                ctx.fillRect(dec.x, dec.y, dec.width, dec.height);
            }
        });

        // Draw Obstacles
        obstacles.forEach(obs => {
            if (obs.sprite && obs.sprite.complete) {
                // Use sprite dimensions for drawing
                ctx.drawImage(obs.sprite, obs.x, obs.y, obs.spriteWidth, obs.spriteHeight);
            } else { // Fallback drawing for obstacles
                ctx.fillStyle = '#8B4513'; // Example: SaddleBrown for fallback
                // Fallback draws using collision dimensions as sprite dimensions aren't guaranteed for fallback shape
                ctx.fillRect(obs.x, obs.y, obs.width, obs.height);
            }
        });

        // Draw Barn
        if (barn.sprite && barn.sprite.complete) { 
            ctx.drawImage(barn.sprite, barn.x, barn.y, barn.width, barn.height); 
        } else {
            ctx.fillStyle = '#A0522D';
            ctx.fillRect(barn.x, barn.y, barn.width, barn.height);
            ctx.strokeStyle = '#5C3317';
            ctx.strokeRect(barn.x, barn.y, barn.width, barn.height);
        }

        // Draw Character
        if (character.sprite && character.sprite.complete) { 
            ctx.drawImage(character.sprite, character.x, character.y, character.width, character.height); 
        } else {
            ctx.fillStyle = '#DEB887';
            ctx.fillRect(character.x, character.y, character.width, character.height);
        }

        // Draw Pigs
        pigs.forEach(pig => {
            if (pig.sprite && pig.sprite.complete) { 
                ctx.drawImage(pig.sprite, pig.x, pig.y, PIG_SIZE, PIG_SIZE); 
            } else {
                ctx.fillStyle = '#FFC0CB';
                ctx.beginPath();
                ctx.arc(pig.x + PIG_SIZE / 2, pig.y + PIG_SIZE / 2, PIG_SIZE / 2, 0, Math.PI * 2);
                ctx.fill();
            }
        });

        // Draw Score and Level
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '20px Rewir';
        ctx.textAlign = 'left';
        ctx.fillText(`Level: ${level}`, 10, 30);
        ctx.textAlign = 'right';
        ctx.fillText(`Score: ${score}`, canvas.width - 10, 30);

        if (levelTransition) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = '40px Rewir';
            ctx.textAlign = 'center';
            ctx.fillText(`Level ${level} Complete!`, canvas.width / 2, canvas.height / 2 - 30);
            ctx.font = '20px Rewir';
            if (waitingForNextLevelInput) {
                ctx.fillText(`Press Enter to Start Level ${level + 1}`, canvas.width / 2, canvas.height / 2 + 20);
            } else {
                ctx.fillText(`Get Ready for Level ${level + 1}...`, canvas.width / 2, canvas.height / 2 + 20);
            }
        }

        if (!gameRunning && !levelTransition) {
            // Display game over message if needed
        }
    }

    // --- Game Loop ---
    function gameLoop() {
        update(); // Always call update to handle input and state changes
        draw();   // Always draw to reflect current state
        requestAnimationFrame(gameLoop);
    }

    // --- Helper function to find a safe random position for an item ---
    function getRandomPosition(itemWidth, itemHeight, existingItemsRects, canvasWidth, canvasHeight) {
        let x, y, newRect;
        let attempts = 0;
        const MAX_ATTEMPTS = 50;
        let overlaps;

        do {
            x = Math.random() * (canvasWidth - itemWidth);
            y = Math.random() * (canvasHeight - itemHeight);
            newRect = { x, y, width: itemWidth, height: itemHeight };
            overlaps = false;
            for (const avoidRect of existingItemsRects) {
                if (isColliding(newRect, avoidRect)) {
                    overlaps = true;
                    break;
                }
            }
            attempts++;
            if (attempts > MAX_ATTEMPTS) {
                console.warn("Max attempts reached for placing item. May overlap or be in suboptimal position.");
                // Fallback: place it somewhere, even if it overlaps slightly or is at 0,0
                // Or, one could choose not to spawn the item if a good spot isn't found.
                break; 
            }
        } while (overlaps);
        return { x, y };
    }

    // --- Initialization ---
    function initializeLevel(_level) {
        pigs = [];
        obstacles = []; // Clear obstacles
        decorations = []; // Clear decorations

        character.x = canvas.width / 2 - ELMER_SIZE / 2;
        character.y = canvas.height - ELMER_SIZE - 10;

        const barnRect = { ...barn }; // barn object already has x,y,w,h
        const elmerStartRect = { 
            x: character.x - ELMER_SIZE, // Add some buffer around elmer's start
            y: character.y - ELMER_SIZE,
            width: ELMER_SIZE * 3,
            height: ELMER_SIZE * 3 
        };
        const barnNoSpawnRect = {
            x: barn.x - BARN_NO_SPAWN_PADDING,
            y: barn.y - BARN_NO_SPAWN_PADDING,
            width: barn.width + (BARN_NO_SPAWN_PADDING * 2),
            height: barn.height + (BARN_NO_SPAWN_PADDING * 2)
        };

        let itemsToAvoidForPlacement = [barnRect, elmerStartRect, barnNoSpawnRect];

        // Place Obstacles (one of each)
        const obstacleTypes = [
            { 
                sprite: tree1Sprite, 
                sWidth: TREE1_SPRITE_WIDTH, sHeight: TREE1_SPRITE_HEIGHT, 
                cWidth: TREE1_COLLISION_WIDTH, cHeight: TREE1_COLLISION_HEIGHT, 
                type: 'tree1' 
            },
            { 
                sprite: tree2Sprite, 
                sWidth: TREE2_SPRITE_WIDTH, sHeight: TREE2_SPRITE_HEIGHT, 
                cWidth: TREE2_COLLISION_WIDTH, cHeight: TREE2_COLLISION_HEIGHT, 
                type: 'tree2' 
            },
            { 
                sprite: fenceSprite, 
                sWidth: FENCE_SPRITE_WIDTH, sHeight: FENCE_SPRITE_HEIGHT, 
                cWidth: FENCE_COLLISION_WIDTH, cHeight: FENCE_COLLISION_HEIGHT, 
                type: 'fence' 
            },
        ];
        obstacleTypes.forEach(obsType => {
            // Use collision dimensions for placement
            const pos = getRandomPosition(obsType.cWidth, obsType.cHeight, itemsToAvoidForPlacement, canvas.width, canvas.height);
            const newObstacle = { 
                ...pos, 
                width: obsType.cWidth, height: obsType.cHeight, // Collision dimensions
                spriteWidth: obsType.sWidth, spriteHeight: obsType.sHeight, // Sprite dimensions
                sprite: obsType.sprite, type: obsType.type 
            };
            obstacles.push(newObstacle);
            itemsToAvoidForPlacement.push({x: newObstacle.x, y: newObstacle.y, width: newObstacle.width, height: newObstacle.height}); // Add collision box to avoid list
        });

        // Place Decorations (one of each)
        const decorationTypes = [
            { sprite: puddleSprite, width: PUDDLE_SIZE, height: PUDDLE_SIZE, type: 'puddle' },
            { sprite: dirtSprite, width: DIRT_SIZE, height: DIRT_SIZE, type: 'dirt' },
        ];
        decorationTypes.forEach(decType => {
            const pos = getRandomPosition(decType.width, decType.height, itemsToAvoidForPlacement, canvas.width, canvas.height);
            decorations.push({ ...pos, width: decType.width, height: decType.height, sprite: decType.sprite, type: decType.type });
            // No need to add decorations to itemsToAvoidForPlacement if other things can overlap them
        });

        for (let i = 0; i < pigsToSpawn; i++) {
            const originalSpeed = 1 + Math.random() * 0.5;
            let newPigX, newPigY;
            let attempts = 0;
            let pigRect;
            do {
                newPigX = Math.random() * (canvas.width - PIG_SIZE);
                newPigY = Math.random() * (canvas.height - PIG_SIZE);
                pigRect = { x: newPigX, y: newPigY, width: PIG_SIZE, height: PIG_SIZE };
                
                let collidesWithSomething = isColliding(pigRect, barnNoSpawnRect);
                if (!collidesWithSomething) {
                    for (const obs of obstacles) {
                        if (isColliding(pigRect, obs)) {
                            collidesWithSomething = true;
                            break;
                        }
                    }
                }
                if (collidesWithSomething) continue; // If already colliding, retry

                attempts++;
                if (attempts > 100) {
                    console.warn("Could not find valid spawn position for pig after 100 attempts (avoiding barn/obstacles). Spawning at random.");
                    newPigX = Math.random() * (canvas.width - PIG_SIZE); // Fallback, might overlap
                    newPigY = Math.random() * (canvas.height - PIG_SIZE);
                    break;
                }
            } while (isColliding(pigRect, barnNoSpawnRect) || obstacles.some(obs => isColliding(pigRect, obs)));
            
            pigs.push({
                x: newPigX,
                y: newPigY,
                vx: (Math.random() - 0.5) * originalSpeed * 2,
                vy: (Math.random() - 0.5) * originalSpeed * 2,
                originalSpeed: originalSpeed,
                sprite: pigSprite,
                isBeingPushed: false
            });
        }
        console.log(`Level ${level} initialized with ${pigsToSpawn} pigs. Character speed: ${character.speed.toFixed(2)}`);
        console.log('Obstacles:', obstacles);
        console.log('Decorations:', decorations);
    }

    // Wait for assets to load
    Promise.all([
        loadImage(elmerSprite),
        loadImage(pigSprite),
        loadImage(barnSprite),
        loadImage(tree1Sprite),
        loadImage(tree2Sprite),
        loadImage(fenceSprite),
        loadImage(puddleSprite),
        loadImage(dirtSprite)
    ]).then(() => {
        console.log("All game assets loaded!");
        initializeLevel(level);
        gameLoop();
    }).catch(error => {
        console.error("Error loading game assets:", error);
        // Fallback or error message display if assets fail to load
        ctx.fillStyle = 'red';
        ctx.font = '20px Rewir';
        ctx.textAlign = 'center';
        ctx.fillText('Error loading game assets. Check console.', canvas.width/2, canvas.height/2);
    });
});

// Helper function to load images
function loadImage(imageObject) {
    return new Promise((resolve, reject) => {
        // Check if the image is already loaded (e.g. from cache or already completed)
        if (imageObject.complete && imageObject.naturalHeight !== 0) {
            resolve(imageObject);
            return;
        }
        imageObject.onload = () => resolve(imageObject);
        imageObject.onerror = (err) => {
            console.error(`Failed to load image: ${imageObject.src}`, err);
            reject(err); // Pass the error object
        };
        // If src is set but loading hasn't started for some reason, or to handle edge cases
        // For example, if an error occurred before this promise was set up.
        // This part is a bit more defensive, might not always be necessary if src is set right before calling this.
        if (!imageObject.src) {
             reject(new Error(`Image source is not set.`));
        }
    });
} 