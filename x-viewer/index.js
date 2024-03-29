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
const c = enumColors;

/** @enum {string} */
const enumColorToShortcode = {
	[c.red]: "r",
	[c.green]: "g",
	[c.blue]: "b",

	[c.yellow]: "y",
	[c.purple]: "p",
	[c.cyan]: "c",

	[c.white]: "w",
	[c.uncolored]: "u",

	[c.orange]: "o",
	[c.light_green]: "l",
	[c.mint]: "m",
	[c.light_blue]: "h",
	[c.dark_purple]: "z",
	[c.pink]: "i",

	[c.black]: "k",
	[c.ghost]: "s",
};

/** @enum {string} */
const enumColorsToHexCode = {
	[c.red]: "#ff666a",
	[c.green]: "#78ff66",
	[c.blue]: "#66a7ff",

	// red + green
	[c.yellow]: "#fcf52a",

	// red + blue
	[c.purple]: "#dd66ff",

	// blue + green
	[c.cyan]: "#87fff5",

	// blue + green + red
	[c.white]: "#ffffff",

	[c.uncolored]: "#aaaaaa",

	[c.orange]: "#fdad4a",
	[c.light_green]: "#bafa48",
	[c.mint]: "#3cfdb2",
	[c.light_blue]: "#33d1ff",
	[c.dark_purple]: "#a186ff",
	[c.pink]: "#ee66b4",

	[c.black]: "#202020",
	[c.ghost]: "rgba(0, 0, 0, 0)",
};

/** @enum {enumColors} */
const enumShortcodeToColor = {};
for (const key in enumColorToShortcode) {
	enumShortcodeToColor[enumColorToShortcode[key]] = key;
}

/** @enum {Object.<string, string>} */
const enumColorMixingResults = {};

const bitfieldToColor = [
    /* 000 */ c.uncolored,
    /* 001 */ c.red,
    /* 010 */ c.green,
    /* 011 */ c.yellow,
    /* 100 */ c.blue,
    /* 101 */ c.purple,
    /* 110 */ c.cyan,
    /* 111 */ c.white,
];
for (let i = 0; i < 1 << 3; ++i) {
    enumColorMixingResults[bitfieldToColor[i]] = {};
    for (let j = 0; j < 1 << 3; ++j) {
        enumColorMixingResults[bitfieldToColor[i]][bitfieldToColor[j]] = bitfieldToColor[i | j];
    }
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

function getRandomShape(allowEmpty = true) {
	let shapes = Object.values(enumSubShapeToShortcode);
	if (allowEmpty) shapes.push("-");
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

function choice(list) {
	return list[getRandomInt(list.length)];
}

function nextIntRange(min, max) {
	return getRandomInt(max - min) + min;
}


function longestPalindrome(str) {
	function isPalindrome(str) {
		const reversed = str.split('').reverse().join('');
		return str === reversed;
	}

	let longest = '', longest_i = 0;
	for (let i = 0; i < str.length; i++) {
		for (let j = i + 1; j < str.length; j++) {
			const substring = str.slice(i, j + 1);
			if (isPalindrome(substring) && substring.length > longest.length) {
				longest = substring;
				longest_i = i;
			}
		}
	}
	return [longest, longest_i];
}

function longestRepeatedSubstring(str) {
	let longest = '', longest_i = 0, longest_r = 0;
	for (let i = 0; i < str.length; i++) {
		for (let j = i + 1; j < str.length; j++) {
			const substring = str.slice(i, j + 1);
			if (str.includes(substring, i + 1) && substring.length > longest.length) {
				longest = substring;
				longest_i = i;
				longest_r = str.indexOf(substring, i + 1);
			}
		}
	}
	return [longest, longest_i, longest_r];
}

function findFeature(subShapes, acceptRandom = false) {
	let s = subShapes.replaceAll('_', '2');

	const [S, S_i] = longestPalindrome(s + s.slice(0, 6));
	const halfS = S.length / 2;
	const symmetricW = halfS * halfS;
	// const symmetricW = S.length * S.length;
	const [R, R_i, R_r] = longestRepeatedSubstring(s + s.slice(0, 3));
	const repeatedW = R.length * R.length;
	const randomizedW = acceptRandom ? 9 : 0;
	const rand = getRandomInt(symmetricW + repeatedW + randomizedW);

	logger = console;
	if (rand < symmetricW) {
		logger.log("symmetric", S, S_i);
		const group1 = [], group2 = [[], []];
		for (let i = 0; i < halfS; i++) {
			const a = S_i + i;
			const b = S_i + S.length - 1 - i;
			group1.push([a, b]);
			group2[0].push(a);
			group2[1].push(b);
		}
		return [group1, group2];
	} else if (rand < symmetricW + repeatedW) {
		logger.log("repeated", R, R_i, R_r);
		const group1 = [], group2 = [[], []];
		for (let i = 0; i < R.length; i++) {
			const a = R_i + i;
			const b = R_r + i;
			group1.push([a, b]);
			group2[0].push(a);
			group2[1].push(b);
		}
		return [group1, group2];
	} else {
		const partNum = getRandomInt(2) + 2;  // [2,3]
		const group = Array.from({ length: partNum }, () => []);
		Array(12).fill(0).forEach(
			(_, index) => group[getRandomInt(partNum)].push(index)
		);
		logger.log("randomized", partNum);
		return [group];
	}
}


const SHAPE_ALL_KIND = [
	'111111111111', '11111111112_', '111111112_2_', '11111112_12_', 
	'1111112_112_', '1111112_2_2_', '111112_1112_', '111112_12_2_', 
	'111112_2_12_', '11112_11112_', '11112_112_2_', '11112_12_12_', 
	'11112_2_112_', '11112_2_2_2_', '1112_1112_2_', '1112_112_12_', 
	'1112_12_112_', '1112_12_2_2_', '1112_2_12_2_', '1112_2_2_12_', 
	'112_112_112_', '112_112_2_2_', '112_12_12_2_', '112_12_2_12_', 
	'112_2_112_2_', '112_2_12_12_', '112_2_2_2_2_', '12_12_12_12_', 
	'12_12_2_2_2_', '12_2_12_2_2_', '2_2_2_2_2_2_'
]

const COLOR_SET = [
	c.uncolored, c.uncolored, c.white,
	c.red, c.green, c.blue,
	c.purple, c.cyan, c.yellow
];

window.computeFreeplayShape = (level = 100) => {
	// let layers = getRandomInt(maxLayer);
	let layers = 1;
	let code = "";
	for (var layerIndex = 0; layerIndex < layers; layerIndex++) {
		let quads = Array(12).fill(null);

		let subShapeStr = choice(SHAPE_ALL_KIND);
		// rotation
		const rot = getRandomInt(12);
		subShapeStr = subShapeStr.slice(rot).concat(subShapeStr.slice(0, rot))
	
		// subShape
		let angle = 0;
		for (let subShape of subShapeStr) {
			if (subShape == '1') {
				quads[angle++] = { subShape, color: c.uncolored, linkedBefore: false};
			} else if (subShape == '2') {
				quads[angle++] = { subShape, color: c.uncolored, linkedBefore: false};
			} else {
				quads[angle++] = { subShape, color: c.uncolored, linkedBefore: true};
			}
		}

		// color
		let groups = findFeature(subShapeStr, level > 50);
		if (true || level <= 50) {
			groups = [choice(groups)];  // simple color group
			// logger.log("group", groups[0]);
		}
		const colorWheel = shuffle(COLOR_SET).slice(0, 4);  // most 4 colors in one layer
		var color = choice(colorWheel); // init color
		for (let group of groups) {
			// diff color for diff part
			for (let part of group) {
				// change color by 50% chance
				if (getRandomInt(2) == 0) {
					color = choice(colorWheel);
				}
				logger.log("part:", color, part);
				part.forEach(i => {
					if (quads[i % 12].linkedBefore) {
						i += 11;
					}
					const oriColor = quads[i % 12].color;
					quads[i % 12].color = enumColorMixingResults[oriColor][color];
				});
			}
		}


		// convert to text
		let layertext = "";
		if (quads[0].linkedBefore)
			layertext = "--"
		for (let i = 0; i < quads.length; i++) {
			const {subShape, color, linkedBefore} = quads[i];
			if (linkedBefore)
				continue;
			layertext += subShape + enumColorToShortcode[color];
		}

		if (layertext == "--2r2r2r2r2r2r" || layerIndex == "1b1b1b1b1b1b1b1b1b1b2b") {
			layerIndex--;
			continue;
		}
		code += layertext + ":";
	}
	code = code.replace(/:+$/, "");  // remove tail ':'
	document.getElementById("code").value = code;
	generate();
};

function shuffle(arr) {
	for (let i = 1; i < arr.length; i++) {
		const random = getRandomInt(i + 1);
		[arr[i], arr[random]] = [arr[random], arr[i]];
	}
	return arr;
}
