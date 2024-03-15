/*
 * Lots of code here is copied 1:1 from actual game files
 *
 */

const maxLayer = 4;

/** @enum {string} */
const enumSubShape = {
	rect: "rect",
	circle: "circle",
	star: "star",
	windmill: "windmill",
	circlestar: "circlestar",
	rectcircle: "rectcircle",
	starrect: "starrect",
	circlewindmill: "circlewindmill",
	rectwindmill: "rectwindmill",
	starwindmill: "starwindmill",
};

const enumCombinedShape = enumSubShape;

/** @enum {string} */
const enumSubShapeToShortcode = {
	[enumSubShape.rect]: "R",
	[enumSubShape.circle]: "C",
	[enumSubShape.star]: "S",
	[enumSubShape.windmill]: "W",
	[enumSubShape.circlestar]: "1",
	[enumSubShape.rectcircle]: "2",
	[enumSubShape.starrect]: "3",
	[enumSubShape.circlewindmill]: "4",
	[enumSubShape.rectwindmill]: "5",
	[enumSubShape.starwindmill]: "6",
};

/** @enum {enumSubShape} */
const enumShortcodeToSubShape = {};
for (const key in enumSubShapeToShortcode) {
	enumShortcodeToSubShape[enumSubShapeToShortcode[key]] = key;
}

const arrayQuadrantIndexToOffset = [
	{ x: 1, y: -1 }, // tr
	{ x: 1, y: 1 }, // br
	{ x: -1, y: 1 }, // bl
	{ x: -1, y: -1 }, // tl
];

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

/////////////////////////////////////////////////////

function radians(degrees) {
	return (degrees * Math.PI) / 180.0;
}

/**
 * Generates the definition from the given short key
 */
function fromShortKey(key) {
	const sourceLayers = key.split(":");
	if (sourceLayers.length > maxLayer) {
		throw new Error("至多允许" + maxLayer + "层");
	}
	let layers = [];
	for (let i = 0; i < sourceLayers.length; ++i) {
		const text = sourceLayers[i];
		if (text.length !== 8) {
			throw new Error(
				"无效层：‘" + text + "’ -> 必须为8个字母"
			);
		}

		if (text === "--".repeat(4)) {
			throw new Error("不允许全空层：" + text);
		}

		/** @type {ShapeLayer} */
		const items = [];

		let linkedShapes = 1;

		// add initial
		for (let i = 0; i < 4; ++i) {
			const shapeText = text[i * 2 + 0];
			const colorText = text[i * 2 + 1];

			if (shapeText == "-") {
				// it's nothing
				if (colorText != "-") {
					throw new Error("不允许图形为空但存在颜色：" + shapeText + colorText);
				}
				items.push(null);
				continue;
			}

			const subShape = enumShortcodeToSubShape[shapeText];
			const color = enumShortcodeToColor[colorText];

			if (colorText == "_") {
				//it's linked
				items.push({
					linkedBefore: true,
					subShape: subShape || null,
					color: null,
				});
				linkedShapes++;
			} else if (subShape) {
				if (!color) {
					throw new Error("无效颜色：" + colorText);
				}
				items.push({
					subShape,
					color,
				});
			} else {
				throw new Error("无效形状：" + shapeText);
			}
		}

		// now loop through items to complete links
		for (let itemIndex = 0; itemIndex < 8; ++itemIndex) {
			const item = items[itemIndex % 4];
			const lastItem = items[(itemIndex + 3) % 4];

			let lastFullItem;
			for (let i = 1; i < 4; i++) {
				const fullItem = items[(itemIndex + 4 - i) % 4];
				if (fullItem && fullItem.subShape) {
					lastFullItem = fullItem;
					break;
				}
			}

			if (item && item.linkedBefore) {
				if (!lastItem || !lastFullItem) {
					throw new Error(
						"前方无可链接：" + text
					);
				}
				lastItem.linkedAfter = true;
				item.color = lastFullItem.color;
				if (!item.subShape) {
					item.subShape = lastFullItem.subShape;
				}
			}
		}

		if (linkedShapes > 3) {
			// we are linked all the way round
			for (let i = 0; i < items.length; i++) {
				items[i].linkedBefore = true;
				items[i].linkedAfter = true;
			}
		}
		layers.push(items);
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
	context.scale((dpi * w) / 23, (dpi * h) / 23);

	const quadrantSize = 10;

	context.fillStyle = "rgba(40, 50, 65, 0.1)";
	context.beginCircle(0, 0, quadrantSize * 1.15);
	context.fill();

	// this is the important part
	for (let layerIndex = 0; layerIndex < layers.length; ++layerIndex) {
		let rotation = 0;

		const layer = layers[layerIndex];

		const layerScale = Math.max(0.1, 0.9 - layerIndex * 0.22);
		const dims = quadrantSize * layerScale;

		let pathActive = false;
		for (let index = 0; index < layer.length; ++index) {
			const item = layer[index];
			if (!item) {
				// this quadrant is empty
				rotation += 90;
				context.rotate(radians(90));
				continue;
			}

			const { linkedBefore, linkedAfter, subShape, color } = item;

			if (!pathActive) {
				context.beginPath();
				pathActive = true;
			}

			context.strokeStyle = "#555";
			context.lineWidth = 1;
			context.fillStyle = enumColorsToHexCode[color];

			if (!linkedBefore) {
				context.moveTo(0, 0);
			}

			drawOuterSubShape(context, dims, subShape);

			if (linkedAfter) {
				//
			} else {
				// we have no linked item
				context.lineTo(-0.5, 0);
				context.fill();
				context.stroke();
				context.closePath();
				pathActive = false;
			}
			// rotate at the end
			rotation += 90;
			context.rotate(radians(90));
		}

		if (pathActive) {
			context.fill();
			context.stroke();

			// outline the first shape once more to fill the gap
			this.drawOuterSubShape(context, dims, layer[0].subShape);
			context.stroke();
			context.closePath();
		}

		// reset rotation for next layer
		context.rotate(radians(-rotation));
	}

	context.restore();
}

function drawOuterSubShape(context, dims, subShape) {
	switch (subShape) {
		case enumSubShape.rect: {
			context.lineTo(0, -dims);
			context.lineTo(dims, -dims);
			context.lineTo(dims, 0);
			break;
		}
		case enumSubShape.star: {
			const moveInwards = dims * 0.4;
			context.lineTo(0, -dims + moveInwards);
			context.lineTo(dims, -dims);
			context.lineTo(dims - moveInwards, 0);
			break;
		}
		case enumSubShape.windmill: {
			const moveInwards = dims * 0.4;
			context.lineTo(0, -dims + moveInwards);
			context.lineTo(dims, -dims);
			context.lineTo(dims, 0);
			break;
		}
		case enumSubShape.circle: {
			context.lineTo(0, -dims);
			context.arcTo(dims, -dims, dims, 0, dims);
			break;
		}

		case enumSubShape.circlestar: {
			const moveInwards = dims * 0.1;
			const starPosition = dims * 0.55;
			context.lineTo(0, -dims);
			context.arc(0, 0, dims, -Math.PI * 0.5, -Math.PI * 0.35);
			context.lineTo(dims, -dims);
			context.lineTo(dims - moveInwards, -dims + starPosition);
			context.arc(0, 0, dims, -Math.PI * 0.13, 0);
			break;
		}
		case enumSubShape.rectcircle: {
			const moveInwards = dims * 0.3;

			context.lineTo(0, -dims);
			context.lineTo(moveInwards, -dims);
			context.arc(
				moveInwards,
				-moveInwards,
				dims - moveInwards,
				-Math.PI * 0.5,
				0
			);
			context.lineTo(dims, 0);
			break;
		}
		case enumSubShape.starrect: {
			const moveInwards = 0.05;
			context.lineTo(0, -dims);
			context.lineTo(moveInwards, -dims);
			context.lineTo(dims, -moveInwards);
			context.lineTo(dims, 0);
			break;
		}
		case enumSubShape.circlewindmill: {
			const moveInwards = dims * 0.5;
			context.lineTo(0, -moveInwards);
			context.lineTo(moveInwards, -dims);
			context.arcTo(dims, -dims, dims, -moveInwards, moveInwards);
			context.lineTo(dims, 0);
			break;
		}
		case enumSubShape.rectwindmill: {
			const moveInwards = dims * 0.2;
			context.lineTo(0, -dims + moveInwards);
			context.lineTo(dims, -dims + moveInwards);
			context.lineTo(dims, 0);
			break;
		}
		case enumSubShape.starwindmill: {
			const moveInwards = dims * 0.6;
			context.lineTo(0, -dims);
			context.lineTo(dims, -dims);
			context.lineTo(moveInwards, 0);
			break;
		}

		default: {
			throw new Error("无效形状：" + subShape);
		}
	}
}

/////////////////////////////////////////////////////

function showError(msg) {
	const errorDiv = document.getElementById("error");
	errorDiv.classList.toggle("hasError", !!msg);
	if (msg) {
		errorDiv.innerText = msg;
	} else {
		errorDiv.innerText = "图形已生成";
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
	const url = "https://si-e.github.io/viewer?" + code;
	navigator.clipboard.writeText(url);
	alert("现在你可以粘贴这个网址：\n" + url);
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
	let layers = getRandomInt(maxLayer);
	let code = "";
	for (var i = 0; i <= layers; i++) {
		let layertext = "";
		for (var y = 0; y <= 3; y++) {
			let randomShape = getRandomShape();
			let randomColor = getRandomColor();

			if (randomShape === "-") {
				randomColor = "-";
				console.log("in");
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

		let layerId = "";
		for (let index = 0; index < 4; ++index) {
			const item = layer[index];
			const lastItem = layer[(index + 3) % 4];
			if (item) {
				const shapeCode = enumSubShapeToShortcode[item.subShape];
				const colorCode = enumColorToShortcode[item.color];
				if (item.linkedBefore) {
					// assert(lastItem, "Item is linked but the item before is null");
					if (item.subShape == lastItem.subShape) {
						layerId += "_";
					} else {
						layerId += shapeCode;
					}
					layerId += "_";

					if (layerId == "________") {
						layerId = shapeCode + colorCode + "______";
					}
					const colors = [...layerId].filter((value, index) => index % 2 == 1).join("");
					if (colors == "____") {
						let firstShapePos = 0;
						for (let i = 6; i >= 0; i -= 2) {
							if (layerId[i] != "_") {
								firstShapePos = i;
							}
						}
						const part1 = layerId.slice(0, firstShapePos + 1);
						const part2 = layerId.slice(firstShapePos + 2);
						layerId = part1 + colorCode + part2;
					}
				} else {
					layerId += shapeCode + enumColorToShortcode[item.color];
				}
			} else {
				layerId += "--";
			}
		}
		id += layerId;

		if (layerIndex < layers.length - 1) {
			id += ":";
		}
	}
	return id;
}
