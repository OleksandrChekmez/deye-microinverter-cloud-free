
/**
 * @param {Buffer} buf 6 bytes
 * @returns {string|null} e.g. "E8:FD:F8:7A:73:6A", or null when the bytes are missing or blank
 */
function formatMacAddress(buf) {
    const blank = buf.every(b => {
        return b === 0x00;
    }) || buf.every(b => {
        return b === 0xff;
    });
    if (buf.length !== 6 || blank) {
        return null;
    }

    return [...buf].map(b => {
        return b.toString(16).padStart(2, "0").toUpperCase();
    }).join(":");
}

function getKeyByValue(obj, value) {
    for (const key in obj) {
        // eslint-disable-next-line no-prototype-builtins
        if (obj.hasOwnProperty(key) && obj[key] === value) {
            return key;
        }
    }
}

function truncateToNullTerminator(str) {
    const nullTerminatorIndex = str.indexOf("\0");
    if (nullTerminatorIndex !== -1) {
        return str.slice(0, nullTerminatorIndex);
    } else {
        return str;
    }
}

function toHexByte(value) {
    return "0x" + value.toString(16).padStart(2, "0");
}


module.exports = {
    formatMacAddress: formatMacAddress,
    getKeyByValue: getKeyByValue,
    toHexByte: toHexByte,
    truncateToNullTerminator: truncateToNullTerminator
};
