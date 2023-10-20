/*
 * Lots of code here is copied 1:1 from actual game files
 *
 */

const maxLayer = 4;

/** @enum {string} */
const enumSubShape = {
	X60: "X60",
	X30: "X30",
};

/** @enum {string} */
const enumSubShapeToShortcode = {
	[enumSubShape.X60]: "2",
	[enumSubShape.X30]: "1",
};

/** @enum {enumSubShape} */
const enumShortcodeToSubShape = {};
for (const key in enumSubShapeToShortcode) {
	enumShortcodeToSubShape[enumSubShapeToShortcode[key]] = key;
}


// From colors.js
/** @enum {string} */
const enumColors = {
	red: "red",
	green: "green",
	blue: "blue",

	yellow: "yellow",
	purple: "purple",
	cyan: "cyan",

	white: "white",
	uncolored: "uncolored",

	orange: "orange",
	light_green: "light_green",
	mint: "mint",
	light_blue: "light_blue",
	dark_purple: "dark_purple",
	pink: "pink",
	
    black: "black",
    ghost: "ghost",
};

/** @enum {string} */
const enumColorToShortcode = {
	[enumColors.red]: "r",
	[enumColors.green]: "g",
	[enumColors.blue]: "b",

	[enumColors.yellow]: "y",
	[enumColors.purple]: "p",
	[enumColors.cyan]: "c",

	[enumColors.white]: "w",
	[enumColors.uncolored]: "u",

	[enumColors.orange]: "o",
	[enumColors.light_green]: "l",
	[enumColors.mint]: "m",
	[enumColors.light_blue]: "h",
	[enumColors.dark_purple]: "z",
	[enumColors.pink]: "i",
	
    [enumColors.black]: "k",
    [enumColors.ghost]: "s",
};

/** @enum {string} */
const enumColorsToHexCode = {
	[enumColors.red]: "#ff666a",
	[enumColors.green]: "#78ff66",
	[enumColors.blue]: "#66a7ff",

	// red + green
	[enumColors.yellow]: "#fcf52a",

	// red + blue
	[enumColors.purple]: "#dd66ff",

	// blue + green
	[enumColors.cyan]: "#87fff5",

	// blue + green + red
	[enumColors.white]: "#ffffff",

	[enumColors.uncolored]: "#aaaaaa",

	[enumColors.orange]: "#fdad4a",
	[enumColors.light_green]: "#bafa48",
	[enumColors.mint]: "#3cfdb2",
	[enumColors.light_blue]: "#33d1ff",
	[enumColors.dark_purple]: "#a186ff",
	[enumColors.pink]: "#ee66b4",

    [enumColors.black]: "#202020",
    [enumColors.ghost]: "rgba(0, 0, 0, 0)",
};

/** @enum {enumColors} */
const enumShortcodeToColor = {};
for (const key in enumColorToShortcode) {
	enumShortcodeToColor[enumColorToShortcode[key]] = key;
}

CanvasRenderingContext2D.prototype.beginCircle = function (x, y, r) {
	if (r < 0.05) {
		this.beginPath();
		this.rect(x, y, 1, 1);
		return;
	}
	this.beginPath();
	this.arc(x, y, r, 0, 2.0 * Math.PI);
};

CanvasRenderingContext2D.prototype.beginRoundedRect = function (x, y, w, h, r) {
	this.beginPath();

	if (r < 0.05) {
		this.rect(x, y, w, h);
		return;
	}

	if (w < 2 * r) {
		r = w / 2;
	}

	if (h < 2 * r) {
		r = h / 2;
	}

	this.moveTo(x + r, y);
	this.arcTo(x + w, y, x + w, y + h, r);
	this.arcTo(x + w, y + h, x, y + h, r);
	this.arcTo(x, y + h, x, y, r);
	this.arcTo(x, y, x + w, y, r);
};

/////////////////////////////////////////////////////

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function radians(degrees) {
	return (degrees * Math.PI) / 180.0;
}

/**
 * Generates the definition from the given short key
 */
function isValidShortKey(key) {
	// logger = console;
	// logger.log("isValidShortKeyInternal(", key, ")");
	logger = {};
	logger.log = (msg, text) => { throw new Error(msg + " " + text); };
	const sourceLayers = key.split(":");
	if (sourceLayers.length === 0 || sourceLayers.length > 4) {
		logger.log("invalid layer number", sourceLayers.length);
		return false;
	}
	for (let text of sourceLayers) {
		if ((text.length & 1) !== 0) {
			logger.log("odd text length", text.length);
			return false;
		}

		const quads = Array(12).fill(null);
		var quad = 0;
		let anyFilled = false;
		for (let subShape_index = 0; subShape_index < text.length / 2; ++subShape_index) {
			const shapeText = text[subShape_index * 2 + 0];
			const colorText = text[subShape_index * 2 + 1];
			const subShape = enumShortcodeToSubShape[shapeText];
			const color = enumShortcodeToColor[colorText];

			if (subShape) {
				if (!color) {
					logger.log("invalid color", text);
					return false;
				}

				let angle;  // Number of quadrant in total 12 quadrants.
				if (shapeText === '1') {
					angle = 1;
				} else if (shapeText === '2') {
					angle = 2;
				} else {  // For compatibility with the original. (BUT the Angle is off by 15 degrees)
					// angle = 3;
					logger.log("invalid subShape for x-shape", text);
					return false;
				}

				// Fill in quadrants.
				if (quad >= 12) {  // No new quadrants are allowed, to make sure the key is unique.
					logger.log("quadrants overflow", text)
					return false;
				}
				for (let a = 0; a < angle; ++a) {
					if (quads[quad % 12] !== null) {
						logger.log("quadrant overlap", text)
						return false;
					}
					quads[quad % 12] = 1;
					quad++;
					anyFilled = true;
				}
			} else if (shapeText === "-") {
				if (colorText !== "-") {
					logger.log("not empty color but empty shape", text);
					return false;
				}
				quad += 1;
			} else {
				logger.log("invalid shape key", text);
				return false;
			}
		}

		if (!anyFilled) {
			logger.log("empty layer", text);
			return false;
		}
		if (quad < 12) {
			logger.log("not enough quadrants", text)
			return false;
		}
	}
	return true;
}

function fromShortKey(key) {
	isValidShortKey(key);
	const sourceLayers = key.split(":");
	let layers = [];
	for (let text of sourceLayers) {
		assert((text.length & 1) === 0, "Invalid shape short key: " + key);

		/** @type {ShapeLayer} */
		const quads = Array(12).fill(null);
		let quad = 0;
		for (let subShape_index = 0; subShape_index < text.length / 2; ++subShape_index) {
			const shapeText = text[subShape_index * 2 + 0];
			const subShape = enumShortcodeToSubShape[shapeText];
			if (subShape) {
				const colorText = text[subShape_index * 2 + 1];
				const color = enumShortcodeToColor[colorText];
				assert(color, "Invalid color short key: " + key);

				let angle;  // Number of quadrant in total 12 quadrants.
				if (shapeText === '1') {
					angle = 1;
				} else if (shapeText === '2') {
					angle = 2;
				} else {  // for compatibility with the original. (BUT the Angle is off by 15 degrees)
					// angle = 3;
					assert(false, "Invalid x-shape key: " + shapeText);
				}

				// Fill in quadrants.
				for (let a = 0; a < angle; ++a) {
					assert(quads[quad] === null, "Quadrant overlap: " + key)
					quads[quad] = {
						linkedBefore: (a > 0),  // not first
						linkedAfter: (a < angle - 1),  // not last
						subShape,
						color,
					};
					quad = (quad + 1) % 12;
				}
			} else if (shapeText === "-") {
				quad++;
			} else {
				assert(false, "Invalid shape key: " + shapeText);
			}
		}
		layers.push(quads);
	}

	return layers;
}


function renderShape(layers) {
	const canvas = /** @type {HTMLCanvasElement} */ (
		document.getElementById("result")
	);
	const context = canvas.getContext("2d");

	context.save();
	context.clearRect(0, 0, 700, 700);

	const w = 384;
	const h = 384;
	const dpi = 1;

	context.translate((w * dpi) / 2, (h * dpi) / 2);
	context.scale((dpi * w) / 26, (dpi * h) / 26);
	
	context.fillStyle = "#e9ecf7";
	
	const quadrantSize = 10;

	context.fillStyle = "rgba(57, 99, 99, 0.3)";  // New color for the substrate circle.
	// context.beginCircle(0, 0, quadrantSize * 1.15);
	const A = quadrantSize * 1.15
	context.beginRoundedRect(-A, -A, A * 2, A * 2, A * 0.5);
	context.fill();

	context.rotate(radians(-90));
	
	for (let layerIndex = 0; layerIndex < layers.length; ++layerIndex) {
		const quadrants = layers[layerIndex];

		const layerScale = Math.max(0.1, 0.9 - layerIndex * 0.22);

		for (let quadrant of quadrants) {
			if (!quadrant) {
				context.rotate(radians(30));
				continue;
			}
			const { linkedBefore, linkedAfter, subShape, color } = quadrant;
			if (linkedBefore) {
				context.rotate(radians(30));
				continue;
			}

			context.fillStyle = enumColorsToHexCode[color];
			context.strokeStyle = "#555";
			context.lineWidth = 1;

			switch (subShape) {
				case enumSubShape.X30: {
					context.beginPath();
					const dims = quadrantSize * layerScale;
					const moveInwards = dims * Math.tan(radians(30 / 2));
					context.moveTo(dims, -moveInwards);
					context.lineTo(dims, +moveInwards);
					context.lineTo(0, 0);
					context.closePath();
					context.fill();
					context.stroke();
				
					context.rotate(radians(30));
					break;
				}
				case enumSubShape.X60: {
					context.rotate(radians(-30));
				
					context.beginPath();
					const dims = quadrantSize * layerScale;
					const moveInwards = dims * Math.tan(radians(30 / 2));
					context.moveTo(dims, moveInwards);
					context.lineTo(dims, dims);
					context.lineTo(moveInwards, dims);
					context.lineTo(0, 0);
					context.closePath();
					context.fill();
					context.stroke();
				
					context.rotate(radians(60));
					break;
				}

				default: {
					throw new Error("Unkown sub shape for X-shape: " + subShape);
				}
			}
		}
	}

	context.restore();
}

/////////////////////////////////////////////////////

function showError(msg) {
	const errorDiv = document.getElementById("error");
	errorDiv.classList.toggle("hasError", !!msg);
	if (msg) {
		errorDiv.innerText = msg;
	} else {
		errorDiv.innerText = "Shape generated";
	}
}

// @ts-ignore
window.generate = () => {
	showError(null);
	// @ts-ignore
	const code = document.getElementById("code").value.trim();

	let parsed = null;
	try {
		parsed = fromShortKey(code);
	} catch (ex) {
		showError(ex);
		return;
	}

	try {
		renderShape(parsed);
	} catch (ex) {
		showError(ex);
		return;
	}
};

// @ts-ignore
window.debounce = (fn) => {
	setTimeout(fn, 0);
};

// @ts-ignore
window.addEventListener("load", () => {
	if (window.location.search) {
		const key = window.location.search.substr(1);
		document.getElementById("code").value = key;
	}
	generate();
});

window.exportShape = () => {
	const canvas = document.getElementById("result");
	const imageURL = canvas.toDataURL("image/png");

	const dummyLink = document.createElement("a");
	dummyLink.download = "shape.png";
	dummyLink.href = imageURL;
	dummyLink.dataset.downloadurl = [
		"image/png",
		dummyLink.download,
		dummyLink.href,
	].join(":");

	document.body.appendChild(dummyLink);
	dummyLink.click();
	document.body.removeChild(dummyLink);
};

window.viewShape = (key) => {
	document.getElementById("code").value = key;
	generate();
};

window.shareShape = () => {
	const code = document.getElementById("code").value.trim();
	const url = "https://si-e.github.io/x-viewer?" + code;
	navigator.clipboard.writeText(url);
	alert("You can paste this url: \n" + url);
};

function getRandomInt(max) {
	return Math.floor(Math.random() * Math.floor(max));
}

function getRandomShape() {
	let shapes = Object.values(enumSubShapeToShortcode);
	shapes.push("-");
	return shapes[getRandomInt(shapes.length)];
}

function getRandomColor() {
	return Object.values(enumColorToShortcode)[
		getRandomInt(Object.keys(enumColorToShortcode).length)
	];
}

window.randomShape = () => {
	// let layers = getRandomInt(maxLayer);
	let layers = 1;
	let code = "";
	for (var i = 0; i < layers; i++) {
		let layertext = "";
		let a = 0;
		let emptyHead = false;
		while (a < 12) {
			let randomShape = getRandomShape();
			let randomColor = getRandomColor();

			if (randomShape === "-") {
				randomColor = "-";
				if (a === 0) emptyHead = true;
				a += 1;
			} else if (randomShape === "1") {
				a += 1;
			} else if (randomShape === "2") {
				if (a + 2 > 12 && !emptyHead) continue;
				a += 2;
			}
			layertext = layertext + randomShape + randomColor;
		}
		//empty layer not allowed
		if (layertext === "--------") {
			i--;
		} else {
			code = code + layertext + ":";
		}
	}
	code = code.replace(/:+$/, "");
	document.getElementById("code").value = code;
	generate();
};

class RandomNumberGenerator {
	choice(list) {
		return list[getRandomInt(list.length)];
	}

	nextIntRange(min, max) {
		return getRandomInt(max - min) + min;
	}

	next() {
		return Math.random()
	}	
}

window.computeFreeplayShape = (level=200) => {
	let layers = [];

	const rng = new RandomNumberGenerator();
	const layerCount = rng.nextIntRange(1, 4 + 1);

	const allColors = generateRandomColorSet(rng);

	const colorWheel = [...Object.values(enumColors).slice()];
	if (level <= 50 && colorWheel.includes(enumColors.uncolored)) {
		colorWheel.splice(colorWheel.indexOf(enumColors.uncolored), 1);
	}

	const symmetries = [
		[
			// radial symmetry
			[0, 2],
			[1, 3],
		],
		[
			// full round
			[0, 1, 2, 3],
		],
	];
	let availableShapes = [
		enumSubShape.rect,
		enumSubShape.circle,
		enumSubShape.star,
		enumCombinedShape.circlestar,
		enumCombinedShape.rectcircle,
		enumCombinedShape.starrect,
	];
	if (rng.next() < 0.5) {
		availableShapes.push(
			enumSubShape.windmill,
			enumCombinedShape.circlewindmill,
			enumCombinedShape.rectwindmill,
			enumCombinedShape.starwindmill
		); // windmill looks good only in radial symmetry
	} else {
		symmetries.push(
			[
				// horizontal axis
				[0, 3],
				[1, 2],
			],
			[
				// vertical axis
				[0, 1],
				[2, 3],
			],
			[
				// diagonal axis
				[0, 2],
				[1],
				[3],
			],
			[
				// other diagonal axis
				[1, 3],
				[0],
				[2],
			]
		);
	}

	const randomShape = () => rng.choice(availableShapes);

	let anyIsMissingTwo = false;

	for (let i = 0; i < layerCount; ++i) {
		const pickedSymmetry = rng.choice(symmetries); // pairs of quadrants that must be the same
		const layer = [null, null, null, null];
		const colors = allColors[i];

		for (let j = 0; j < pickedSymmetry.length; ++j) {
			const group = pickedSymmetry[j];
			const shape = randomShape();
			for (let k = 0; k < group.length; ++k) {
				const quad = group[k];
				layer[quad] = {
					subShape: shape,
					color: null,
				};
			}
		}

		let availableColors = colorWheel.slice();

		for (let j = 0; j < colors.length; ++j) {
			const group = colors[j];
			const colorIndex = rng.nextIntRange(0, availableColors.length);
			for (let k = 0; k < group.length; ++k) {
				const quad = group[k];
				if (layer[quad]) {
					layer[quad].color = availableColors[colorIndex];
				}
			}
			availableColors.splice(colorIndex, 1);
		}

		for (let j = 0; j < pickedSymmetry.length; ++j) {
			const group = pickedSymmetry[j];
			if (rng.next() > 0.75) {
				// link stuff
				const color = rng.choice(colorWheel);
				for (let k = 0; k < group.length; ++k) {
					const index = group[k];

					if (!layer[index]) {
						continue;
					}
					layer[index].color = color;

					const quadBefore = (index + 3) % 4;
					const quadAfter = (index + 1) % 4;
					const linkedBefore = group.includes(quadBefore) && !!layer[quadBefore];
					layer[index].linkedBefore = linkedBefore;

					const linkedAfter = group.includes(quadAfter) && !!layer[quadAfter];
					layer[index].linkedAfter = linkedAfter;
				}
			}
		}

		if (level > 100 && rng.next() > 0.9) {
			layer[rng.nextIntRange(0, 4)] = null;
		}

		// Sometimes they actually are missing *two* ones!
		// Make sure at max only one layer is missing it though, otherwise we could
		// create an uncreateable shape
		if (level > 150 && rng.next() > 0.9 && !anyIsMissingTwo) {
			layer[rng.nextIntRange(0, 4)] = null;
			anyIsMissingTwo = true;
		}

		// and afterwards update links
		for (let quadrantIndex = 0; quadrantIndex < 4; ++quadrantIndex) {
			const quadrant = layer[quadrantIndex];
			if (quadrant) {
				const lastQuadrant = layer[(quadrantIndex + 3) % 4];
				const nextQuadrant = layer[(quadrantIndex + 1) % 4];
				if (!lastQuadrant) {
					quadrant.linkedBefore = false;
				}
				if (!nextQuadrant) {
					quadrant.linkedAfter = false;
				}
			}
		}

		layers.push(layer);
	}
	let code = getShapeId(layers);
	document.getElementById("code").value = code;
	generate();
};

function generateRandomColorSet(rng) {
    const allPositions = [];

    for (let i = 0; i < 4; i++) {
        const positions = [
            [
                [0, 1],
                [2, 3],
            ],
            [
                [1, 2],
                [0, 3],
            ],
            [
                [0, 2],
                [1, 3],
            ],
        ];

        const chance = rng.next();

        if (chance > 0.8) {
            positions.push([[0, 1, 2, 3]]);
        }

        allPositions.push(rng.choice(positions));
    }

    return allPositions;
}

function getShapeId(layers) {
	let id = "";
	for (let layerIndex = 0; layerIndex < layers.length; ++layerIndex) {
		const layer = layers[layerIndex];

		let anyContents = false;
		for (let quadrant = 0; quadrant < layer.length; ++quadrant) {
			const item = layer[quadrant];

			if (item) {
				if (item.linkedBefore) {  // New logic. (undefined\false or true)
					if (!anyContents) {
						id += "--";
					}
				} else {
					id += enumSubShapeToShortcode[item.subShape] + enumColorToShortcode[item.color];
					anyContents = true;
				}
			} else {
				id += "--";
			}
		}

		if (layerIndex < layers.length - 1) {
			id += ":";
		}
	}
	return id;
}
